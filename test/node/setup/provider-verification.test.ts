import { describe, expect, it, vi } from 'vitest';
import { assertDemoSeedTarget, verifyProviderPreflight } from '../../../scripts/setup/provider-verification.mjs';
import { applySetup } from '../../../scripts/setup/apply.mjs';

function dbWithRows(rows: unknown[]) {
  const prepare = vi.fn((_sql: string) => ({
    async first() {
      const next = rows.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  }));
  return { prepare };
}

describe('provider verification preflight', () => {
  it('strictly accepts only the single Supabase SELECT 1 row', async () => {
    const db = dbWithRows([{ ok: 1 }]);
    await expect(verifyProviderPreflight({
      backend: 'supabase', mode: 'deploy', db,
    })).resolves.toBe(true);
    expect(db.prepare.mock.calls.map(([sql]) => sql)).toEqual(['SELECT 1 AS ok']);

    for (const row of [null, { ok: 1, extra: 2 }, { ok: '1' }, { nope: 1 }]) {
      const invalid = dbWithRows([row]);
      await expect(verifyProviderPreflight({ backend: 'supabase', mode: 'local', db: invalid }))
        .rejects.toThrow(/^Selected database provider verification failed before setup mutations$/);
      expect(invalid.prepare).toHaveBeenCalledTimes(1);
    }
  });

  it('redacts Supabase connection failures and performs no schema probe after failure', async () => {
    const secret = 'postgres://user:private-password@db.example.test/church';
    const db = dbWithRows([new Error(`connect failed: ${secret}`)]);
    let failure: unknown;
    try {
      await verifyProviderPreflight({ backend: 'supabase', mode: 'local', db, secrets: [secret] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe('Error: Selected database provider verification failed before setup mutations');
    expect(String(failure)).not.toContain(secret);
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('uses SELECT 1 for local D1 and a read-only D1 list validation for deploy D1', async () => {
    const local = dbWithRows([{ ok: 1 }]);
    await expect(verifyProviderPreflight({ backend: 'd1', mode: 'local', db: local })).resolves.toBe(true);
    expect(local.prepare).toHaveBeenCalledWith('SELECT 1 AS ok');

    const remoteDb = { prepare: vi.fn(() => { throw new Error('must not query remote D1 before it exists'); }) };
    const runner = { run: vi.fn(async () => ({ stdout: '[]', stderr: '', exitCode: 0 })) };
    await expect(verifyProviderPreflight({
      backend: 'd1', mode: 'deploy', db: remoteDb,
      runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc',
    })).resolves.toBe(true);
    expect(runner.run).toHaveBeenCalledWith('wrangler', ['d1', 'list', '--json', '--config', 'wrangler.jsonc'], expect.objectContaining({ allowNonzero: true }));
    expect(remoteDb.prepare).not.toHaveBeenCalled();

    runner.run.mockResolvedValueOnce({ stdout: 'not-json', stderr: 'private-token', exitCode: 0 });
    await expect(verifyProviderPreflight({
      backend: 'd1', mode: 'deploy', db: remoteDb,
      runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', secrets: ['private-token'],
    })).rejects.toThrow(/^Selected database provider verification failed before setup mutations$/);
  });

  it('requires an exact recorded deploy D1 name and ID without mutating it', async () => {
    const runner = { run: vi.fn(async (_file: string, _args: string[]) => ({
      stdout: JSON.stringify([{ name: 'church-db', uuid: 'recorded-id' }]), stderr: '', exitCode: 0,
    })) };
    const common = {
      backend: 'd1' as const, mode: 'deploy' as const, db: dbWithRows([]), runner,
      wranglerBin: 'wrangler', configPath: 'wrangler.jsonc',
    };
    await expect(verifyProviderPreflight({
      ...common,
      resources: { d1DatabaseName: 'church-db', d1DatabaseId: 'recorded-id' },
    })).resolves.toBe(true);
    await expect(verifyProviderPreflight({
      ...common,
      resources: { d1DatabaseName: 'church-db', d1DatabaseId: 'different-id' },
    })).rejects.toThrow(/^Selected database provider verification failed before setup mutations$/);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run.mock.calls.every(([, args]) => args[0] === 'd1' && args[1] === 'list')).toBe(true);
  });

  it('suppresses only provider-specific missing-table errors during the post-connectivity demo probe', async () => {
    for (const [backend, missing] of [
      ['d1', new Error('no such table: people')],
      ['supabase', Object.assign(new Error('relation "people" does not exist'), { code: '42P01' })],
    ] as const) {
      const fresh = dbWithRows([missing]);
      await expect(assertDemoSeedTarget({ backend, db: fresh, canonicalDemoReady: vi.fn(async () => false) })).resolves.toBe(true);
      expect(fresh.prepare).toHaveBeenCalledTimes(1);
    }

    const denied = dbWithRows([new Error('permission denied for table people')]);
    await expect(assertDemoSeedTarget({ backend: 'supabase', db: denied, canonicalDemoReady: vi.fn(async () => false) }))
      .rejects.toThrow(/^Existing database could not be inspected safely before setup mutations$/);
  });

  it('refuses demo seed collisions but permits an already canonical demo rerun', async () => {
    const collision = dbWithRows([{ count: 1 }]);
    await expect(assertDemoSeedTarget({
      backend: 'd1', db: collision,
      canonicalDemoReady: vi.fn(async () => false),
    })).rejects.toThrow(/fictional demo data.*fresh database/i);

    const rerun = dbWithRows([{ count: 12 }]);
    await expect(assertDemoSeedTarget({
      backend: 'd1', db: rerun,
      canonicalDemoReady: vi.fn(async () => true),
    })).resolves.toBe(true);
  });

  it('stops the action pipeline after only the initial installation-origin load when provider verification fails', async () => {
    const db = dbWithRows([new Error('private provider failure')]);
    const ensureApply = vi.fn();
    const state = {
      load: vi.fn(async () => 'managed'),
      has: vi.fn(async () => false),
      mark: vi.fn(),
      getEvidence: vi.fn(),
    };
    await expect(applySetup({
      backend: 'supabase', existingInstallation: false,
      actions: ['verify-provider', 'ensure-resources'],
    } as any, {
      steps: {
        'verify-provider': { apply: vi.fn(), verify: () => verifyProviderPreflight({ backend: 'supabase', mode: 'local', db }) },
        'ensure-resources': { apply: ensureApply, verify: vi.fn() },
      },
      stateStore: state,
    })).rejects.toThrow(/Failed step: verify-provider[\s\S]*Selected database provider verification failed before setup mutations/);
    expect(state.load).toHaveBeenCalledOnce();
    expect(state.mark).not.toHaveBeenCalled();
    expect(ensureApply).not.toHaveBeenCalled();
  });
});
