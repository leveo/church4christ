// Nightly D1→R2 backup tests (workers project, live R2 binding). Ports the
// reference stack's backup.test.ts scripted-fetch approach for runD1Backup and
// adds the runBackup cron-wrapper cases: not-configured skip, and export-error
// logged (not thrown). The dump lands under backups/ in the MEDIA bucket, which
// is unreachable through the /media route — that guard is asserted in
// test/media.test.ts ("never serves a key outside uploads/").
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runD1Backup, runBackup, type BackupEnv } from '../src/lib/backup';

const backupEnv: BackupEnv = {
  CF_ACCOUNT_ID: 'acct123',
  D1_DATABASE_ID: 'db456',
  D1_EXPORT_TOKEN: 'token789',
  MEDIA: env.MEDIA,
};

type FetchStep = (url: string, init?: RequestInit) => Response;

// Scripted fetch double: call N gets script[N]; records every call for assertions.
function scriptedFetcher(script: FetchStep[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const step = script[calls.length - 1];
    if (!step) throw new Error(`unexpected fetch call #${calls.length} to ${url}`);
    return step(url, init);
  }) as typeof fetch;
  return { fetcher, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('runD1Backup', () => {
  it('polls the export to completion and stores the dump in R2 under a UTC date key', async () => {
    const { fetcher, calls } = scriptedFetcher([
      () => json({ result: { success: false, at_bookmark: 'bm-1' } }),
      () => json({ result: { success: false, at_bookmark: 'bm-1', status: 'processing' } }),
      () => json({ result: { success: true, at_bookmark: 'bm-1', signed_url: 'https://storage.example.com/dump.sql' } }),
      () => new Response('PRAGMA foreign_keys=OFF;\nINSERT INTO users VALUES (1);'),
    ]);

    const key = await runD1Backup(backupEnv, new Date('2026-07-02T09:00:00Z'), fetcher);
    expect(key).toBe('backups/2026-07-02.sql');

    // Kickoff: correct endpoint, method, auth, and polling body.
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/d1/database/db456/export');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer token789');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ output_format: 'polling' });
    // Polls carry the bookmark forward.
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ output_format: 'polling', current_bookmark: 'bm-1' });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ output_format: 'polling', current_bookmark: 'bm-1' });
    // The dump download hits the signed URL.
    expect(calls[3].url).toBe('https://storage.example.com/dump.sql');
    // And the object landed in the real (test) R2 binding.
    const obj = await env.MEDIA.get('backups/2026-07-02.sql');
    expect(await obj?.text()).toContain('PRAGMA foreign_keys=OFF;');
  });

  it('throws with the HTTP status when the export request is rejected', async () => {
    const { fetcher } = scriptedFetcher([() => json({ errors: [{ message: 'bad token' }] }, 401)]);
    await expect(runD1Backup(backupEnv, new Date('2026-07-02T09:00:00Z'), fetcher)).rejects.toThrow(/401/);
  });

  it('throws with the HTTP status when a poll request fails', async () => {
    const { fetcher } = scriptedFetcher([
      () => json({ result: { success: false, at_bookmark: 'bm-1' } }),
      () => json({ errors: [] }, 500),
    ]);
    await expect(runD1Backup(backupEnv, new Date('2026-07-02T09:00:00Z'), fetcher)).rejects.toThrow(/500/);
  });

  it('gives up after the maximum number of polls', async () => {
    const pending: FetchStep = () => json({ result: { success: false, at_bookmark: 'bm-1' } });
    const { fetcher } = scriptedFetcher(Array.from({ length: 25 }, () => pending));
    await expect(runD1Backup(backupEnv, new Date('2026-07-02T09:00:00Z'), fetcher)).rejects.toThrow(/poll/i);
  });
});

describe('runD1Backup — nested result shape (current API)', () => {
  it('reads signed_url from result.result and stores the dump', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return Promise.resolve(json({ result: { at_bookmark: 'bm-9', status: 'active' } }));
      if (calls.length === 2)
        return Promise.resolve(json({ result: { success: true, at_bookmark: 'bm-9', status: 'complete', result: { filename: 'x.sql', signed_url: 'https://storage.example.com/nested.sql' } } }));
      return Promise.resolve(new Response('-- nested dump', { status: 200 }));
    }) as typeof fetch;
    const key = await runD1Backup(
      { CF_ACCOUNT_ID: 'acct', D1_DATABASE_ID: 'db', D1_EXPORT_TOKEN: 'tok', MEDIA: env.MEDIA },
      new Date('2026-07-02T09:00:00Z'),
      fetcher,
    );
    expect(key).toBe('backups/2026-07-02.sql');
    expect(calls[2].url).toBe('https://storage.example.com/nested.sql');
    expect(await (await env.MEDIA.get(key))?.text()).toBe('-- nested dump');
  });
});

describe('runBackup — cron wrapper', () => {
  it('skips and logs when the backup is not configured, never touching fetch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn(() => {
      throw new Error('fetch must not be called when unconfigured');
    }) as unknown as typeof fetch;
    // No CF_ACCOUNT_ID / D1_DATABASE_ID / D1_EXPORT_TOKEN — the demo-deploy shape.
    await expect(runBackup({ MEDIA: env.MEDIA }, new Date('2026-07-02T09:00:00Z'), fetcher)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('backup skipped: not configured');
    expect(fetcher).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('logs the failure and does not throw when the export API errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetcher } = scriptedFetcher([() => json({ errors: [{ message: 'bad token' }] }, 401)]);
    // Configured, but the export request 401s: runBackup swallows it into a log.
    await expect(runBackup(backupEnv, new Date('2026-07-02T09:00:00Z'), fetcher)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^backup failed:.*401/));
    err.mockRestore();
  });

  it('runs the full export and reports the stored key on the happy path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetcher } = scriptedFetcher([
      () => json({ result: { success: true, at_bookmark: 'bm-1', signed_url: 'https://storage.example.com/ok.sql' } }),
      () => new Response('-- wrapper dump'),
    ]);
    await runBackup(backupEnv, new Date('2026-07-03T09:00:00Z'), fetcher);
    expect(log).toHaveBeenCalledWith('backup complete: backups/2026-07-03.sql');
    expect(await (await env.MEDIA.get('backups/2026-07-03.sql'))?.text()).toBe('-- wrapper dump');
    log.mockRestore();
  });
});
