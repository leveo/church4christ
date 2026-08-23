import type { AppDb } from './appDb';

/**
 * Revoke every current identity path for an active canonical person. Both
 * statements run in one database batch: session epoch changes and challenge
 * supersession therefore commit together or not at all. A consumed OTP without
 * its ownership/account proof is also revoked so an idempotent recovery path
 * cannot finish after global sign-out.
 */
export async function revokeIdentitySessions(
  db: AppDb,
  personId: number,
): Promise<{ revoked: true; sessionEpoch: number } | { revoked: false }> {
  if (!Number.isSafeInteger(personId) || personId <= 0) return { revoked: false };
  const results = await db.batch([
    db.prepare(`UPDATE people SET session_epoch=session_epoch+1,updated_at=datetime('now')
      WHERE id=?1 AND active=1 AND deleted_at IS NULL AND identity_state='active'
        AND auth_disabled_at IS NULL AND merged_into_person_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.loser_person_id=people.id)
      RETURNING session_epoch`).bind(personId),
    db.prepare(`UPDATE identity_challenges SET superseded_at=datetime('now')
      WHERE person_id=?1 AND superseded_at IS NULL
        AND (consumed_at IS NULL OR ownership_consumed_at IS NULL)
        AND purpose IN ('login','signup','claim','contact_change','recovery','step_up')
        AND EXISTS (SELECT 1 FROM people p WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL
          AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND p.merged_into_person_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.loser_person_id=p.id))`).bind(personId),
  ]);
  const rows = results[0]?.results as Array<{ session_epoch?: number }> | undefined;
  const epoch = rows?.[0]?.session_epoch;
  return rows?.length === 1 && Number.isSafeInteger(epoch) && (epoch as number) >= 1
    ? { revoked: true, sessionEpoch: epoch as number }
    : { revoked: false };
}
