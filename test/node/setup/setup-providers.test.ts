import { describe, expect, it, vi } from 'vitest';
import { createCommandRunner } from '../../../scripts/setup/commands.mjs';
import { renderAnonymousBinds, sqlLiteral } from '../../../scripts/setup/sql.mjs';
import {
  D1CliDb,
  ensureD1Database,
  ensureR2Bucket,
} from '../../../scripts/setup/providers/d1.mjs';
import {
  ensureHyperdrive,
  openPostgresSetupDb,
  parseHyperdriveTable,
} from '../../../scripts/setup/providers/postgres.mjs';

describe('shell-free setup command runner', () => {
  it('redacts tagged args and stdin everywhere and never invokes a shell', async () => {
    const calls: any[] = [];
    const runner = createCommandRunner({
      exec: async (file: string, args: string[], options: any) => {
        calls.push({ file, args, options });
        return { stdout: `echo ${args[4]} ${options.input.trim()}`, stderr: `bad ${args[4]}`, exitCode: 0 };
      },
    });
    const result = await runner.run(
      'wrangler',
      ['hyperdrive', 'create', 'x', '--connection-string', 'tiny'],
      { input: 'pw\n', secretArgIndexes: [4] },
    );
    expect(result).toEqual(expect.objectContaining({
      stdout: 'echo [REDACTED] [REDACTED]',
      stderr: 'bad [REDACTED]',
    }));
    expect(JSON.stringify(result)).not.toMatch(/tiny|pw/);
    expect(result.displayCommand).toContain('[REDACTED]');
    expect(calls[0]).toMatchObject({ options: { shell: false } });
    expect(calls[0].options).not.toHaveProperty('displayCommand');
  });

  it('redacts stdout, stderr, and thrown errors on nonzero and spawn failure', async () => {
    const nonzero = createCommandRunner({ exec: async () => ({ stdout: 's3', stderr: 's3', exitCode: 2 }) });
    await expect(nonzero.run('x', ['s3'], { secretArgIndexes: [0] })).rejects.not.toThrow(/s3/);
    const failed = createCommandRunner({ exec: async () => { throw new Error('spawn exposed s3'); } });
    await expect(failed.run('x', ['s3'], { secretArgIndexes: [0] })).rejects.toThrow(/\[REDACTED\]/);
  });

  it('allows explicit nonzero result inspection without weakening redaction', async () => {
    const runner = createCommandRunner({ exec: async () => ({ stdout: 'missing token', stderr: 'token', exitCode: 1 }) });
    await expect(runner.run('x', ['token'], { secretArgIndexes: [0], allowNonzero: true })).resolves.toEqual(
      expect.objectContaining({ stdout: 'missing [REDACTED]', stderr: '[REDACTED]', exitCode: 1 }),
    );
  });

  it('derives multiline, URL-component, explicit, and secret environment values', async () => {
    const url = 'postgres://alice:p%40ss@db.test/app?token=q%2Bv';
    const input = 'API_KEY=line-one\npassword=line-two\n';
    const env = { SAFE: 'visible', CLOUDFLARE_API_TOKEN: 'env-token', CUSTOM: 'custom-secret' };
    const echoed = [url, 'alice', 'p%40ss', 'p@ss', 'q%2Bv', 'q+v', input, 'line-one', 'line-two', 'env-token', 'custom-secret', 'xy'].join('|');
    const runner = createCommandRunner({ exec: async () => ({ stdout: echoed, stderr: echoed, exitCode: 3 }) });
    const result = await runner.run('x', [url], {
      secretArgIndexes: [0], input, env, allowNonzero: true,
      secretValues: ['xy'], secretEnvKeys: ['CUSTOM'],
    });
    expect(JSON.stringify(result)).not.toMatch(/alice|p%40ss|p@ss|q%2Bv|q\+v|line-one|line-two|env-token|custom-secret|xy/);
    expect(result.stdout).toContain('[REDACTED]');
  });

  it('bounds real child output and times out real children', async () => {
    const runner = createCommandRunner();
    await expect(runner.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(200))"], { maxOutputBytes: 32 }))
      .rejects.toThrow(/output limit/i);
    await expect(runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }))
      .rejects.toThrow(/timed out/i);
  });

  it('rejects unsafe input types before execution', async () => {
    const exec = vi.fn();
    const runner = createCommandRunner({ exec });
    await expect(runner.run('', [])).rejects.toThrow(/file/i);
    await expect(runner.run('x', ['ok', 1] as any)).rejects.toThrow(/argument/i);
    await expect(runner.run('x', [], { secretArgIndexes: [2] })).rejects.toThrow(/secret.*index/i);
    await expect(runner.run('x', [], { allowNonzero: 'yes' as any })).rejects.toThrow(/allowNonzero/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it('defaults omitted options and secret indexes for direct and resource-helper runs', async () => {
    const calls: string[][] = [];
    const runner = createCommandRunner({ exec: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'd1') return { stdout: JSON.stringify([{ name: 'site-db', uuid: 'db-id' }]), stderr: '', exitCode: 0 };
      if (args[0] === 'r2') return { stdout: JSON.stringify({ name: 'site-media' }), stderr: '', exitCode: 0 };
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    } });
    await expect(runner.run('node', ['--version'])).resolves.toEqual(expect.objectContaining({ stdout: 'ok' }));
    await expect(ensureD1Database({ runner, wranglerBin: 'wrangler', configPath: 'c', name: 'site-db' }))
      .resolves.toEqual({ name: 'site-db', id: 'db-id', created: false });
    await expect(ensureR2Bucket({ runner, wranglerBin: 'wrangler', configPath: 'c', name: 'site-media' }))
      .resolves.toEqual({ name: 'site-media', created: false });
    expect(calls).toHaveLength(3);
  });
});

describe('anonymous SQL bind rendering', () => {
  it('replaces placeholders only in code and escapes supported literals', () => {
    const query = `SELECT '?' AS sq, "?" AS dq, ? AS a, ? AS b, ? AS c, ? AS d -- ?\n/* ? */`;
    expect(renderAnonymousBinds(query, [null, true, 4.5, "o'hara"])).toBe(
      `SELECT '?' AS sq, "?" AS dq, NULL AS a, 1 AS b, 4.5 AS c, 'o''hara' AS d -- ?\n/* ? */`,
    );
    expect(renderAnonymousBinds(`SELECT 'it''s ?' AS s, "a""?" AS i, ?`, ['x'])).toContain("'x'");
  });

  it('enforces exact bind counts and rejects unsupported values and unterminated SQL', () => {
    expect(() => renderAnonymousBinds('SELECT ?', [])).toThrow(/bind count/i);
    expect(() => renderAnonymousBinds('SELECT 1', ['extra'])).toThrow(/bind count/i);
    expect(() => sqlLiteral(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i);
    expect(() => sqlLiteral(undefined)).toThrow(/unsupported/i);
    expect(() => renderAnonymousBinds("SELECT 'oops", [])).toThrow(/unterminated.*quote/i);
    expect(() => renderAnonymousBinds('SELECT /* oops', [])).toThrow(/unterminated.*comment/i);
  });

  it('treats backslash before a quote as ordinary SQL text for D1 and Postgres binds', () => {
    const query = "SELECT 'backslash\\' AS value, ? AS bound";
    expect(renderAnonymousBinds(query, ["o'hara"])).toBe("SELECT 'backslash\\' AS value, 'o''hara' AS bound");
    expect(renderAnonymousBinds(query, ['value'], (_value, position) => `$${position}`))
      .toBe("SELECT 'backslash\\' AS value, $1 AS bound");
  });

  it('implements SQLite numbered, repeated, and mixed placeholder semantics', () => {
    const params = Array.from({ length: 13 }, (_, index) => index + 1);
    expect(renderAnonymousBinds('SELECT ?1, ?13, ?1', params)).toBe('SELECT 1, 13, 1');
    expect(renderAnonymousBinds('SELECT ?2, ?, ?1, ?', [10, 20, 30, 40])).toBe('SELECT 20, 30, 10, 40');
    expect(renderAnonymousBinds('SELECT ?2, ?, ?1, ?', [10, 20, 30, 40], (_value, position) => `$${position}`))
      .toBe('SELECT $2, $3, $1, $4');
    expect(() => renderAnonymousBinds('SELECT ?0', [1])).toThrow(/positive/i);
    expect(() => renderAnonymousBinds('SELECT ?2', [1])).toThrow(/bind count/i);
    expect(() => renderAnonymousBinds('SELECT ?1', [1, 2])).toThrow(/bind count/i);
  });

  it('skips PostgreSQL dollar quotes and supports nested block comments fail-closed', () => {
    const query = 'SELECT $$?$$, $tag$?$tag$, ? /* outer ? /* inner ? */ still ? */';
    expect(renderAnonymousBinds(query, ['ok'])).toBe("SELECT $$?$$, $tag$?$tag$, 'ok' /* outer ? /* inner ? */ still ? */");
    expect(() => renderAnonymousBinds('SELECT $tag$ ?', [])).toThrow(/unterminated.*dollar/i);
    expect(() => renderAnonymousBinds('SELECT /* outer /* inner */', [])).toThrow(/unterminated.*comment/i);
  });
});

describe('D1 setup adapter', () => {
  it('implements immutable first/all/run/batch and validated local Wrangler args', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_file: string, args: string[]) => {
      calls.push(args);
      const result = { results: [{ id: 7, name: null }], success: true, meta: { changes: 1 } };
      return { stdout: JSON.stringify(args.includes("SELECT id FROM people WHERE email='d@example.com';\nSELECT id FROM people WHERE email='e@example.com'") ? [result, result] : [result]) };
    } };
    const db = new D1CliDb({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', persistTo: '.wrangler/state' });
    const base = db.prepare('SELECT id FROM people WHERE email=?');
    expect(await base.bind('a@example.com').first()).toEqual({ id: 7, name: null });
    expect(await base.bind('b@example.com').first('name')).toBeNull();
    expect((await base.bind('c@example.com').all()).success).toBe(true);
    expect((await db.batch([base.bind('d@example.com'), base.bind('e@example.com')]))).toHaveLength(2);
    expect(calls[0]).toEqual([
      'd1', 'execute', 'DB', '--local', '--command', "SELECT id FROM people WHERE email='a@example.com'",
      '--json', '--yes', '--config', 'wrangler.jsonc', '--persist-to', '.wrangler/state',
    ]);
  });

  it('uses remote scope and strictly rejects malformed or unsuccessful Wrangler JSON', async () => {
    const outputs = ['not-json', '{}', '[]', JSON.stringify([{ success: false }]), JSON.stringify([{ success: true, results: {} }])];
    for (const stdout of outputs) {
      const db = new D1CliDb({ runner: { run: async () => ({ stdout }) }, wranglerBin: 'w', configPath: 'c', mode: 'deploy' });
      await expect(db.prepare('SELECT 1').all()).rejects.toThrow(/Wrangler D1/i);
    }
    const runner = { run: async () => ({ stdout: '' }) };
    expect(() => new D1CliDb({ runner, wranglerBin: 'w', configPath: 'c', mode: 'bad' as any })).toThrow(/mode/i);
    expect(() => new D1CliDb({ runner, wranglerBin: 'w', configPath: 'c', mode: 'deploy', persistTo: 'x' })).toThrow(/persist/i);
    expect(() => new D1CliDb({ runner, wranglerBin: 'w', configPath: 'c', mode: 'local', persistTo: '--remote' })).toThrow(/persist/i);
  });

  it('rejects any failed D1 result and batches statements in one Wrangler call', async () => {
    const failed = new D1CliDb({
      runner: { run: async () => ({ stdout: JSON.stringify([{ success: false, results: [], meta: {} }, { success: true, results: [], meta: {} }]) }) },
      wranglerBin: 'w', configPath: 'c', mode: 'deploy',
    });
    await expect(failed.prepare('SELECT 1').all()).rejects.toThrow(/unsuccessful|invalid/i);

    const calls: string[][] = [];
    const db = new D1CliDb({
      runner: { run: async (_file: string, args: string[]) => {
        calls.push(args);
        return { stdout: JSON.stringify([
          { success: true, results: [{ id: 1 }], meta: { changes: 0 } },
          { success: true, results: [], meta: { changes: 1 } },
        ]) };
      } },
      wranglerBin: 'w', configPath: 'c', mode: 'local',
    });
    const results = await db.batch([db.prepare('SELECT ?1').bind(1), db.prepare('DELETE FROM t WHERE id=?').bind(2)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('SELECT 1;\nDELETE FROM t WHERE id=2');
    expect(results).toHaveLength(2);
  });
});

describe('Cloudflare resource discovery', () => {
  it('lists D1 before create and after create, selecting an exact unique name', async () => {
    const calls: string[][] = [];
    let lists = 0;
    const runner = { run: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[1] === 'list') return { stdout: JSON.stringify(lists++ ? [{ name: 'site-db', uuid: 'd1-id' }] : []) };
      return { stdout: 'Created prose must be ignored' };
    } };
    await expect(ensureD1Database({ runner, wranglerBin: 'wrangler', configPath: 'c', name: 'site-db' })).resolves.toEqual({ name: 'site-db', id: 'd1-id', created: true });
    expect(calls).toEqual([
      ['d1', 'list', '--json', '--config', 'c'],
      ['d1', 'create', 'site-db', '--config', 'c'],
      ['d1', 'list', '--json', '--config', 'c'],
    ]);
  });

  it('fails closed on malformed or ambiguous D1 discovery', async () => {
    const runner = { run: async () => ({ stdout: JSON.stringify([{ name: 'x', uuid: '1' }, { name: 'x', uuid: '2' }]) }) };
    await expect(ensureD1Database({ runner, wranglerBin: 'w', configPath: 'c', name: 'x' })).rejects.toThrow(/ambiguous/i);
    const malformed = { run: async () => ({ stdout: '{}' }) };
    await expect(ensureD1Database({ runner: malformed, wranglerBin: 'w', configPath: 'c', name: 'x' })).rejects.toThrow(/D1 list/i);
  });

  it('uses R2 info --json as the exact-name probe and distinguishes not found', async () => {
    const calls: any[] = [];
    let probes = 0;
    const runner = { run: async (_file: string, args: string[], options?: any) => {
      calls.push([args, options]);
      if (args[2] === 'info') return probes++ === 0
        ? { stdout: '', stderr: 'bucket not found', exitCode: 1 }
        : { stdout: JSON.stringify({ name: 'site-media' }), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    } };
    await expect(ensureR2Bucket({ runner, wranglerBin: 'w', configPath: 'c', name: 'site-media' })).resolves.toEqual({ name: 'site-media', created: true });
    expect(calls.map(([args]) => args)).toEqual([
      ['r2', 'bucket', 'info', 'site-media', '--json', '--config', 'c'],
      ['r2', 'bucket', 'create', 'site-media', '--config', 'c'],
      ['r2', 'bucket', 'info', 'site-media', '--json', '--config', 'c'],
    ]);
    expect(calls[0][1]).toEqual({ allowNonzero: true });
  });

  it('fails closed for R2 auth errors and mismatched info', async () => {
    const auth = { run: async () => ({ stdout: '', stderr: 'Authentication error', exitCode: 1 }) };
    await expect(ensureR2Bucket({ runner: auth, wranglerBin: 'w', configPath: 'c', name: 'x' })).rejects.toThrow(/probe failed/i);
    const mismatch = { run: async () => ({ stdout: JSON.stringify({ name: 'other' }), stderr: '', exitCode: 0 }) };
    await expect(ensureR2Bucket({ runner: mismatch, wranglerBin: 'w', configPath: 'c', name: 'x' })).rejects.toThrow(/mismatch/i);
  });
});

describe('Hyperdrive resource adapter', () => {
  const table = (rows: string[]) => [
    '📋 Listing Hyperdrive configs',
    '┌────┬──────┬──────┬──────┬──────┬────────┬──────────┬─────────┬──────┬─────────────────────────┐',
    '│ id │ name │ user │ host │ port │ scheme │ database │ caching │ mtls │ origin_connection_limit │',
    '├────┼──────┼──────┼──────┼──────┼────────┼──────────┼─────────┼──────┼─────────────────────────┤',
    ...rows,
    '└────┴──────┴──────┴──────┴──────┴────────┴──────────┴─────────┴──────┴─────────────────────────┘',
  ].join('\n');

  it('strictly parses the current Wrangler table and rejects drift or duplicates', () => {
    expect(parseHyperdriveTable(table(['│ abc-123 │ site-hd │ u │ h │ 5432 │ Postgres │ db │ disabled │ {} │ 5 │']))).toEqual([{ id: 'abc-123', name: 'site-hd' }]);
    expect(() => parseHyperdriveTable('id name\nabc site')).toThrow(/format/i);
    expect(() => parseHyperdriveTable(table(['│ a │ x │ u │ h │ 1 │ Postgres │ d │ x │ {} │ 1 │', '│ b │ x │ u │ h │ 1 │ Postgres │ d │ x │ {} │ 1 │']), 'x')).toThrow(/ambiguous/i);
    const captured4107 = `\n ⛅️ wrangler 4.107.0\n────────────────────\n${table(['│ abc-123 │ site-hd │ u │ h │ 5432 │ Postgres │ db │ disabled │ {} │ 5 │'])}`;
    expect(parseHyperdriveTable(captured4107)).toEqual([{ id: 'abc-123', name: 'site-hd' }]);
    expect(() => parseHyperdriveTable(`unknown preamble\n${table([])}`)).toThrow(/format/i);
    expect(() => parseHyperdriveTable(`\u001b[31m${table([])}`)).toThrow(/format/i);
  });

  it('lists before/create/after, redacts the connection URL argument, and ignores create prose', async () => {
    const calls: any[] = [];
    let lists = 0;
    const runner = { run: async (_file: string, args: string[], options?: any) => {
      calls.push({ args, options });
      if (args[1] === 'list') return { stdout: lists++ ? table(['│ hd-id │ site-hd │ u │ h │ 5432 │ Postgres │ db │ x │ {} │ 1 │']) : table([]) };
      return { stdout: 'created secret://leak' };
    } };
    await expect(ensureHyperdrive({ runner, wranglerBin: 'w', configPath: 'c', name: 'site-hd', connectionString: 'postgres://secret', allowSecretInArgv: true })).resolves.toEqual({ name: 'site-hd', id: 'hd-id', created: true });
    expect(calls[1]).toEqual({
      args: ['hyperdrive', 'create', 'site-hd', '--connection-string', 'postgres://secret', '--config', 'c'],
      options: { secretArgIndexes: [4] },
    });
    expect(JSON.stringify(await ensureHyperdrive({ runner: { run: async () => ({ stdout: table(['│ hd-id │ site-hd │ u │ h │ 5432 │ Postgres │ db │ x │ {} │ 1 │']) }) }, wranglerBin: 'w', configPath: 'c', name: 'site-hd', connectionString: 'postgres://secret' }))).not.toContain('postgres://secret');
  });

  it('refuses Hyperdrive credential argv exposure unless explicitly allowed', async () => {
    const runner = { run: async () => ({ stdout: table([]) }) };
    await expect(ensureHyperdrive({ runner, wranglerBin: 'w', configPath: 'c', name: 'site-hd', connectionString: 'postgres://secret' }))
      .rejects.toThrow(/process-list.*short-lived scoped credentials/i);
    await expect(ensureHyperdrive({ runner, wranglerBin: 'w', configPath: 'c', name: 'site-hd', connectionString: 'postgres://secret', allowSecretInArgv: 'yes' as any }))
      .rejects.toThrow(/allowSecretInArgv/i);
  });
});

describe('Postgres setup AppDb adapter', () => {
  it('uses max:1, prepare:false, int8 mapping, placeholders, result contract, and awaited close', async () => {
    const calls: any[] = [];
    let endCalls = 0;
    const rows: any = [{ id: 9 }]; rows.count = 2;
    const sql: any = {
      unsafe: async (query: string, params: unknown[]) => { calls.push({ query, params }); return rows; },
      begin: async (fn: any) => fn({ unsafe: sql.unsafe }),
      end: async () => { await Promise.resolve(); endCalls += 1; },
    };
    const factory: any = vi.fn(() => sql);
    const opened = openPostgresSetupDb('postgres://user:pass@db/app', { postgresFactory: factory });
    expect(factory).toHaveBeenCalledWith('postgres://user:pass@db/app', expect.objectContaining({ max: 1, prepare: false }));
    expect(factory.mock.calls[0][1].types.int8AsNumber.parse('12')).toBe(12);
    const stmt = opened.db.prepare(`SELECT '?' AS q, id FROM t WHERE a=? AND b=?`).bind('a', 2);
    expect(await stmt.first()).toEqual({ id: 9 });
    expect(calls[0]).toEqual({ query: `SELECT '?' AS q, id FROM t WHERE a=$1 AND b=$2`, params: ['a', 2] });
    expect(await stmt.all()).toEqual({ results: rows, meta: { changes: 2 }, success: true });
    await Promise.all([opened.close(), opened.close()]);
    expect(endCalls).toBe(1);
    expect(() => openPostgresSetupDb('https://user:pass@db/app', { postgresFactory: factory })).toThrow(/Postgres.*URL/i);
    expect(() => openPostgresSetupDb('postgres://db/app', { postgresFactory: factory })).toThrow(/credentials/i);
  });
});
