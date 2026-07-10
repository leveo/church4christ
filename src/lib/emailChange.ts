// Email-change flow. Email is the login identity, so a change is a two-step,
// token-gated operation (mirrors the magic-link peek/consume pattern):
//   requestEmailChange  — normalize + validate + uniqueness + rate-limit, stash
//                          the target in people.pending_email, mint a token.
//   peekEmailChange     — GET confirm page: is the token valid? (never mutates —
//                          mail scanners prefetch links and must not burn them).
//   consumeEmailChange  — POST: atomically consume, RE-check uniqueness (the
//                          address could have been claimed since the request),
//                          swap people.email, clear pending_email, and bump
//                          session_epoch so every outstanding session is revoked
//                          (the member must sign in again with the new address).
//
// Prior email_change tokens are invalidated (marked used) on re-issue rather than
// hard-deleted, so the 3/hour rate limit — which counts tokens created in the
// window — stays countable; a deleted row would erase that history.
import type { AppDb } from './appDb';
import { EMAIL_CHANGE_RATE_LIMIT, consumeToken, createEmailChangeToken, peekToken } from './auth';

// Deliberately conservative: a single @, no whitespace, a dotted domain. This is
// a format gate, not RFC-5322 validation — the real proof the address works is
// that the confirmation link is delivered to it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** True when another live people row already uses this (normalized) address. */
async function emailTakenByOther(db: AppDb, email: string, personId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM people WHERE email = ?1 AND id <> ?2 AND deleted_at IS NULL')
    .bind(email, personId)
    .first<{ id: number }>();
  return row !== null;
}

/**
 * Begin an email change: validate + normalize the target, reject an address
 * already on another live row (`taken`), rate-limit to EMAIL_CHANGE_RATE_LIMIT
 * per hour (`rate_limited`), invalidate any prior email_change tokens, stash the
 * target in people.pending_email, and return the raw token to email. Returns an
 * `{ error }` object instead of throwing.
 */
export async function requestEmailChange(
  db: AppDb,
  personId: number,
  newEmail: string,
): Promise<{ raw: string; newEmail: string } | { error: 'invalid' | 'taken' | 'rate_limited' }> {
  const email = normalizeEmail(newEmail);
  if (!EMAIL_RE.test(email)) return { error: 'invalid' };
  if (await emailTakenByOther(db, email, personId)) return { error: 'taken' };

  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tokens
       WHERE person_id = ?1 AND purpose = 'email_change' AND created_at > datetime('now', '-60 minutes')`,
    )
    .bind(personId)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= EMAIL_CHANGE_RATE_LIMIT) return { error: 'rate_limited' };

  // Supersede any outstanding email_change token for this person so an old link
  // can never confirm a stale target once a new request is made.
  await db
    .prepare(
      `UPDATE tokens SET used_at = datetime('now')
       WHERE person_id = ?1 AND purpose = 'email_change' AND used_at IS NULL`,
    )
    .bind(personId)
    .run();

  const { raw } = await createEmailChangeToken(db, personId);
  await db.prepare('UPDATE people SET pending_email = ?1 WHERE id = ?2').bind(email, personId).run();
  return { raw, newEmail: email };
}

/**
 * Peek a confirmation token WITHOUT consuming it (GET confirm page — survives
 * mail-scanner prefetches). Returns the owning person and the pending target, or
 * null when the token is unknown/expired/used or the person has no pending change.
 */
export async function peekEmailChange(
  db: AppDb,
  rawToken: string,
): Promise<{ personId: number; newEmail: string } | null> {
  const tok = await peekToken(db, rawToken, 'email_change');
  if (!tok) return null;
  const row = await db
    .prepare('SELECT pending_email FROM people WHERE id = ? AND deleted_at IS NULL')
    .bind(tok.person_id)
    .first<{ pending_email: string | null }>();
  if (!row?.pending_email) return null;
  return { personId: tok.person_id, newEmail: row.pending_email };
}

/**
 * Consume a confirmation token (POST). Atomically burns the token, then RE-checks
 * that the pending address is still free (it could have been claimed since the
 * request); on collision it clears pending_email and returns `taken` without
 * touching the live email. On success it swaps people.email, clears pending_email,
 * and bumps session_epoch (revoking every session), returning old+new for the
 * notice to the former address.
 */
export async function consumeEmailChange(
  db: AppDb,
  rawToken: string,
): Promise<{ personId: number; oldEmail: string; newEmail: string } | { error: 'taken' | 'invalid' }> {
  const tok = await consumeToken(db, rawToken, 'email_change');
  if (!tok) return { error: 'invalid' };
  const personId = tok.person_id;

  const person = await db
    .prepare('SELECT email, pending_email FROM people WHERE id = ? AND deleted_at IS NULL')
    .bind(personId)
    .first<{ email: string; pending_email: string | null }>();
  if (!person?.pending_email) return { error: 'invalid' };

  const newEmail = person.pending_email;
  if (await emailTakenByOther(db, newEmail, personId)) {
    // Someone else claimed the address between request and confirm. The token is
    // already spent; abandon the pending change and leave the login email as-is.
    await db.prepare('UPDATE people SET pending_email = NULL WHERE id = ?').bind(personId).run();
    return { error: 'taken' };
  }

  await db
    .prepare(
      `UPDATE people SET email = ?1, pending_email = NULL, session_epoch = session_epoch + 1 WHERE id = ?2`,
    )
    .bind(newEmail, personId)
    .run();
  return { personId, oldEmail: person.email, newEmail };
}
