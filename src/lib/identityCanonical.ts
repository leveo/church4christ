import type { AppDb } from './appDb';
import { normalizeEmail, normalizeName } from './identityNormalize';

export const IDENTITY_CANONICAL_NORMALIZATION_VERSION = 1;
export const IDENTITY_CANONICAL_REFRESH_LIMIT = 32;

type StalePerson = { person_id: number; email: string; display_name: string };
export type CanonicalRefreshResult = Readonly<{ complete: boolean; refreshed: number; failed: boolean }>;

function exactKeyStatement(db: AppDb, row: StalePerson) {
  return db.prepare(`INSERT INTO identity_person_canonical_keys
    (person_id,legacy_email_key,normalized_name_key,normalization_version,is_current,source_email,source_display_name,updated_at)
    VALUES(?1,?2,?3,?4,1,?5,?6,datetime('now'))
    ON CONFLICT(person_id) DO UPDATE SET legacy_email_key=excluded.legacy_email_key,
      normalized_name_key=excluded.normalized_name_key,normalization_version=excluded.normalization_version,is_current=1,
      source_email=excluded.source_email,source_display_name=excluded.source_display_name,updated_at=datetime('now')`)
    .bind(row.person_id, normalizeEmail(row.email), normalizeName(row.display_name), IDENTITY_CANONICAL_NORMALIZATION_VERSION,
      row.email, row.display_name);
}

export function exactIdentityPersonCanonicalKeyStatement(db: AppDb, input: {
  personId: number; email: string; displayName: string;
}) {
  return exactKeyStatement(db, { person_id: input.personId, email: input.email, display_name: input.displayName });
}

/**
 * Refreshes at most one small indexed batch. Source snapshots are checked by
 * database triggers, so a concurrent person edit can only make this fail stale.
 */
export async function refreshIdentityPersonCanonicalKeys(
  db: AppDb,
  options: Readonly<{ limit?: number }> = {},
): Promise<CanonicalRefreshResult> {
  const limit = options.limit ?? IDENTITY_CANONICAL_REFRESH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('identity_canonical_refresh_invalid');
  try {
    const stale = await db.prepare(`SELECT k.person_id,p.email,p.display_name FROM identity_person_canonical_keys k
      JOIN people p ON p.id=k.person_id WHERE k.is_current=0 ORDER BY k.person_id LIMIT ?1`)
      .bind(limit + 1).all<StalePerson>();
    const selected = stale.results.slice(0, limit);
    // Each guarded upsert is independently safe. Avoid coupling registry
    // maintenance to the later account-mutation transaction boundary.
    for (const row of selected) await exactKeyStatement(db, row).run();
    return Object.freeze({ complete: stale.results.length <= limit, refreshed: selected.length, failed: false });
  } catch {
    return Object.freeze({ complete: false, refreshed: 0, failed: true });
  }
}

/** Maintenance entrypoint for setup/admin jobs; request paths use one bounded batch. */
export async function reindexIdentityPersonCanonicalKeys(db: AppDb, maxBatches = 10_000): Promise<number> {
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) throw new Error('identity_canonical_reindex_invalid');
  let refreshed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await refreshIdentityPersonCanonicalKeys(db, { limit: 256 });
    refreshed += result.refreshed;
    if (result.failed) throw new Error('identity_canonical_reindex_failed');
    if (result.complete) return refreshed;
  }
  throw new Error('identity_canonical_reindex_incomplete');
}
