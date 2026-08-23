// One-time tokens for magic sign-in links and email accept/decline links. The
// raw token is returned to the caller exactly once (embed it in the emailed
// link); only its SHA-256 hex hash is ever persisted. Ported from
// the reference stack's src/lib/auth.ts, adapted to createLoginToken/createRespondToken
// (rate limit folded into createLoginToken) with exported TTL/limit constants.

import type { AppDb } from './appDb';
import { normalizeEmail } from './identityNormalize';

export type TokenPurpose = 'login' | 'respond' | 'email_change';

export const LOGIN_TTL_MIN = 15;
export const RESPOND_TTL_DAYS = 14;
export const LOGIN_RATE_LIMIT = 3;
export const LOGIN_RATE_WINDOW_MIN = 15;
export const EMAIL_CHANGE_TTL_MIN = 60;
export const EMAIL_CHANGE_RATE_LIMIT = 3; // per person per hour

const TTL_SQL: Record<TokenPurpose, string> = {
  login: `+${LOGIN_TTL_MIN} minutes`,
  respond: `+${RESPOND_TTL_DAYS} days`,
  email_change: `+${EMAIL_CHANGE_TTL_MIN} minutes`,
};

/** A validated token's owning person and (for respond tokens) assignment. */
export interface TokenRow {
  person_id: number;
  assignment_id: number | null;
  expected_session_epoch: number | null;
}
export type LoginTokenIssue = { raw: string } | { rateLimited: true } | { notEligible: true };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // base64url without padding
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function insertToken(
  db: AppDb,
  personId: number,
  purpose: TokenPurpose,
  assignmentId: number | null,
  sessionEpoch: number | null = null,
): Promise<string> {
  const raw = randomToken();
  await db
    .prepare(
      `INSERT INTO tokens (person_id, token_hash, purpose, assignment_id, expected_session_epoch, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', ?6))`,
    )
    .bind(personId, await sha256Hex(raw), purpose, assignmentId, sessionEpoch, TTL_SQL[purpose])
    .run();
  return raw;
}

async function eligibleLegacyLoginEpoch(db: AppDb, personId: number): Promise<number | null> {
  const loginIdentities = await db.prepare(`SELECT p.session_epoch,p.email,c.normalized_value FROM people p
    JOIN verified_contact_owners o ON o.person_id=p.id
    JOIN contact_points c ON c.id=o.contact_point_id AND c.kind='email'
    JOIN person_contact_links l ON l.person_id=p.id AND l.contact_point_id=c.id AND l.ended_at IS NULL
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
      AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`).bind(personId)
    .all<{ session_epoch: number; email: string; normalized_value: string }>();
  // Legacy tokens are retained only as a grace path for the same contact that
  // has an explicit verified-owner proof; a people.email value is never proof.
  const loginIdentity = loginIdentities.results.find((candidate) => normalizeEmail(candidate.email) === candidate.normalized_value);
  const sessionEpoch = loginIdentity?.session_epoch ?? null;
  return Number.isSafeInteger(sessionEpoch) && sessionEpoch >= 0 ? sessionEpoch : null;
}

/** Login tokens issued for this person within the rate-limit window. */
async function countRecentLoginTokens(db: AppDb, personId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tokens
       WHERE person_id = ?1 AND purpose = 'login' AND created_at > datetime('now', ?2)`,
    )
    .bind(personId, `-${LOGIN_RATE_WINDOW_MIN} minutes`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Issue a magic sign-in token. Returns `{rateLimited:true}` (and issues nothing)
 * when the person already has LOGIN_RATE_LIMIT login tokens inside the window.
 */
export async function createLoginToken(
  db: AppDb,
  personId: number,
): Promise<LoginTokenIssue> {
  // Validate ownership before counting so an unverified contact never gets a
  // token (nor a distinguishable rate-limit side effect).
  const sessionEpoch = await eligibleLegacyLoginEpoch(db, personId);
  if (sessionEpoch === null) return { notEligible: true };
  if ((await countRecentLoginTokens(db, personId)) >= LOGIN_RATE_LIMIT) {
    return { rateLimited: true };
  }
  return { raw: await insertToken(db, personId, 'login', null, sessionEpoch) };
}

/** Issue an email-change confirmation token. Rate limiting and prior-token
 *  invalidation are the caller's responsibility (see emailChange.ts). */
export async function createEmailChangeToken(db: AppDb, personId: number): Promise<{ raw: string }> {
  void db; void personId;
  throw new Error('identity_legacy_email_change_retired');
}

/** Issue an accept/decline token bound to a roster assignment. Not rate limited. */
export async function createRespondToken(
  db: AppDb,
  personId: number,
  assignmentId: number,
): Promise<{ raw: string }> {
  return { raw: await insertToken(db, personId, 'respond', assignmentId) };
}

/**
 * Check a token is valid (unused, unexpired, right purpose) WITHOUT consuming it
 * — for the GET confirm page, which must survive mail-scanner prefetches.
 */
export async function peekToken(
  db: AppDb,
  rawToken: string,
  purpose: TokenPurpose,
): Promise<TokenRow | null> {
  if (purpose === 'email_change') return null;
  return await db
    .prepare(
      `SELECT person_id, assignment_id, expected_session_epoch FROM tokens
       WHERE token_hash = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > datetime('now')
       AND (purpose <> 'login' OR EXISTS (SELECT 1 FROM people p WHERE p.id=tokens.person_id
         AND p.session_epoch=tokens.expected_session_epoch AND p.active=1 AND p.deleted_at IS NULL
         AND p.identity_state='active' AND p.auth_disabled_at IS NULL))`,
    )
    .bind(await sha256Hex(rawToken), purpose)
    .first<TokenRow>();
}

/**
 * Atomically consume a token: the UPDATE's WHERE clause is the validity check,
 * so two concurrent consumers can never both succeed. Returns null if the token
 * is unknown, expired, already used, or for a different purpose.
 */
export async function consumeToken(
  db: AppDb,
  rawToken: string,
  purpose: TokenPurpose,
): Promise<TokenRow | null> {
  if (purpose === 'email_change') return null;
  return await db
    .prepare(
      `UPDATE tokens SET used_at = datetime('now')
       WHERE token_hash = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > datetime('now')
       AND (purpose <> 'login' OR EXISTS (SELECT 1 FROM people p WHERE p.id=tokens.person_id
         AND p.session_epoch=tokens.expected_session_epoch AND p.active=1 AND p.deleted_at IS NULL
         AND p.identity_state='active' AND p.auth_disabled_at IS NULL))
       RETURNING person_id, assignment_id, expected_session_epoch`,
    )
    .bind(await sha256Hex(rawToken), purpose)
    .first<TokenRow>();
}
