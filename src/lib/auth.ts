// One-time tokens for magic sign-in links and email accept/decline links. The
// raw token is returned to the caller exactly once (embed it in the emailed
// link); only its SHA-256 hex hash is ever persisted. Ported from
// the reference stack's src/lib/auth.ts, adapted to createLoginToken/createRespondToken
// (rate limit folded into createLoginToken) with exported TTL/limit constants.

import type { AppDb } from './appDb';

export type TokenPurpose = 'login' | 'respond';

export const LOGIN_TTL_MIN = 15;
export const RESPOND_TTL_DAYS = 14;
export const LOGIN_RATE_LIMIT = 3;
export const LOGIN_RATE_WINDOW_MIN = 15;

const TTL_SQL: Record<TokenPurpose, string> = {
  login: `+${LOGIN_TTL_MIN} minutes`,
  respond: `+${RESPOND_TTL_DAYS} days`,
};

/** A validated token's owning person and (for respond tokens) assignment. */
export interface TokenRow {
  person_id: number;
  assignment_id: number | null;
}

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
): Promise<string> {
  const raw = randomToken();
  await db
    .prepare(
      `INSERT INTO tokens (person_id, token_hash, purpose, assignment_id, expires_at)
       VALUES (?1, ?2, ?3, ?4, datetime('now', ?5))`,
    )
    .bind(personId, await sha256Hex(raw), purpose, assignmentId, TTL_SQL[purpose])
    .run();
  return raw;
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
): Promise<{ raw: string } | { rateLimited: true }> {
  if ((await countRecentLoginTokens(db, personId)) >= LOGIN_RATE_LIMIT) {
    return { rateLimited: true };
  }
  return { raw: await insertToken(db, personId, 'login', null) };
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
  return await db
    .prepare(
      `SELECT person_id, assignment_id FROM tokens
       WHERE token_hash = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > datetime('now')`,
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
  return await db
    .prepare(
      `UPDATE tokens SET used_at = datetime('now')
       WHERE token_hash = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > datetime('now')
       RETURNING person_id, assignment_id`,
    )
    .bind(await sha256Hex(rawToken), purpose)
    .first<TokenRow>();
}
