// Nightly D1 -> R2 backup via the D1 REST export API (slice 7). Ported from the
// reference stack (dcfc-website src/lib/backup.ts). Verified flow: POST /export
// with {"output_format":"polling"} -> {result:{at_bookmark}}; re-POST
// {"current_bookmark": bookmark} until result.success && result.signed_url; GET
// signed_url -> SQL dump; store as backups/YYYY-MM-DD.sql. The backups/ prefix is
// unreachable through the /media route (uploads/-only guard), so the dump is never
// publicly downloadable (asserted in test/media.test.ts).

export interface BackupEnv {
  CF_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
  D1_EXPORT_TOKEN: string;
  MEDIA: R2Bucket;
}

// The three config values may be unset on a demo deploy (CF_ACCOUNT_ID +
// D1_DATABASE_ID are commented-out vars in wrangler.jsonc, D1_EXPORT_TOKEN a
// secret). runBackup log-and-skips when any is missing, so MEDIA is the only
// binding the wrapper always has.
export type MaybeBackupEnv = {
  CF_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  D1_EXPORT_TOKEN?: string;
  MEDIA: R2Bucket;
};

interface ExportResult {
  success?: boolean;
  at_bookmark?: string;
  signed_url?: string;
  status?: string;
  error?: string;
  // Current API nests the payload one level deeper (result.result.signed_url);
  // the Workflows example reads it flat. Accept both shapes.
  result?: { filename?: string; signed_url?: string };
}

const signedUrlOf = (r?: ExportResult) => r?.signed_url ?? r?.result?.signed_url;

const MAX_POLLS = 20;

export async function runD1Backup(env: BackupEnv, now: Date, fetcher: typeof fetch = fetch): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/export`;
  const headers = {
    authorization: `Bearer ${env.D1_EXPORT_TOKEN}`,
    'content-type': 'application/json',
  };

  const kickoff = await fetcher(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ output_format: 'polling' }),
  });
  if (!kickoff.ok) throw new Error(`D1 export request failed: HTTP ${kickoff.status} — ${(await kickoff.text()).slice(0, 300)}`);
  let result = ((await kickoff.json()) as { result?: ExportResult }).result;

  // Bounded polling loop; the API is built for immediate re-polling, no sleep needed.
  let polls = 0;
  while (!signedUrlOf(result)) {
    if (result?.status === 'error' || result?.error)
      throw new Error(`D1 export reported error: ${result.error ?? 'unknown'}`);
    if (!result?.at_bookmark) throw new Error('D1 export response missing at_bookmark');
    if (++polls > MAX_POLLS) throw new Error(`D1 export still pending after ${MAX_POLLS} polls, giving up`);
    const res = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ output_format: 'polling', current_bookmark: result.at_bookmark }),
    });
    if (!res.ok) throw new Error(`D1 export poll failed: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    result = ((await res.json()) as { result?: ExportResult }).result;
  }

  const dump = await fetcher(signedUrlOf(result)!);
  if (!dump.ok) throw new Error(`D1 dump download failed: HTTP ${dump.status}`);
  // R2 put needs a known length for streams; this site's dump is small, so buffer it.
  const body = await dump.arrayBuffer();
  const key = `backups/${now.toISOString().slice(0, 10)}.sql`;
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: 'application/sql' } });
  return key;
}

/**
 * Cron entry point. Skips gracefully (logs, no throw) when the backup is not
 * configured — the demo deploy ships without CF_ACCOUNT_ID / D1_DATABASE_ID /
 * D1_EXPORT_TOKEN and must keep running its other crons — and swallows any
 * export failure into a log line so a bad night never rejects the scheduled
 * invocation. `now`/`fetcher` are injectable for tests.
 */
export async function runBackup(env: MaybeBackupEnv, now: Date = new Date(), fetcher: typeof fetch = fetch): Promise<void> {
  if (!env.CF_ACCOUNT_ID || !env.D1_DATABASE_ID || !env.D1_EXPORT_TOKEN) {
    console.log('backup skipped: not configured');
    return;
  }
  try {
    const key = await runD1Backup(env as BackupEnv, now, fetcher);
    console.log(`backup complete: ${key}`);
  } catch (err) {
    console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
