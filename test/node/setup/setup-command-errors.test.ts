import { describe, expect, it } from 'vitest';
import missingTable from './fixtures/wrangler-d1-missing-table.json';
import { createCommandRunner } from '../../../scripts/setup/commands.mjs';
import { D1CliDb } from '../../../scripts/setup/providers/d1.mjs';
import { assertDemoSeedTarget } from '../../../scripts/setup/provider-verification.mjs';

describe('Wrangler structured command errors', () => {
  it('preserves the observed Wrangler 4.107 D1 diagnostic emitted only to stdout', async () => {
    const runner = createCommandRunner({ exec: async () => missingTable });
    const db = new D1CliDb({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local' });
    await expect(db.prepare('SELECT key FROM settings').all()).rejects.toThrow('no such table: settings: SQLITE_ERROR');
  });

  it('lets the existing provider guard recognize an absent people table without treating permission failures as fresh', async () => {
    const failure = { ...missingTable, stdout: missingTable.stdout.replace('settings', 'people') };
    const runner = createCommandRunner({ exec: async () => failure });
    const db = new D1CliDb({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local' });
    await expect(assertDemoSeedTarget({ backend: 'd1', db })).resolves.toBe(true);
    failure.stdout = JSON.stringify({ error: { text: 'permission denied' } });
    await expect(assertDemoSeedTarget({ backend: 'd1', db })).rejects.toThrow('Existing database could not be inspected safely');
  });

  it('extracts only error.text and redacts JSON-decoded secrets before reporting it', async () => {
    const secret = 'a-quoted-"secret"-value';
    const runner = createCommandRunner({ secretValues: [secret], exec: async () => ({
      stdout: JSON.stringify({ error: { text: `provider rejected ${secret}`, token: 'private-error-field' }, results: [{ value: 'private-query-row' }] }),
      stderr: '', exitCode: 1,
    }) });
    const failure = await runner.run('wrangler', ['d1', 'execute', 'DB', '--json']).catch((error: Error) => error);
    expect(String(failure)).toContain('provider rejected [REDACTED]');
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toMatch(/private-error-field|private-query-row/);
  });

  it.each([
    'private raw stdout',
    '{"error":{"text":',
    JSON.stringify({ results: [{ secret: 'private-query-row' }] }),
    JSON.stringify({ error: { token: 'private-error-field' } }),
    JSON.stringify({ error: { text: { secret: 'private-object-field' } } }),
    JSON.stringify([{ error: { text: 'private-array-field' } }]),
  ])('does not dump raw stdout or unexpected JSON shapes: %s', async (stdout) => {
    const runner = createCommandRunner({ exec: async () => ({ stdout, stderr: '', exitCode: 1 }) });
    await expect(runner.run('wrangler', ['--json'])).rejects.not.toThrow(/private|secret|results/);
  });

  it('keeps existing stderr diagnostics authoritative and does not append unrelated stdout', async () => {
    const runner = createCommandRunner({ exec: async () => ({ ...missingTable, stderr: 'permission denied' }) });
    await expect(runner.run('wrangler', ['--json'])).rejects.toThrow('permission denied');
    await expect(runner.run('wrangler', ['--json'])).rejects.not.toThrow('no such table');
  });

  it('bounds the extracted diagnostic and preserves explicit allowNonzero results', async () => {
    const result = { stdout: JSON.stringify({ error: { text: `diagnostic:${'x'.repeat(5000)}` } }), stderr: '', exitCode: 1 };
    const runner = createCommandRunner({ exec: async () => result });
    const failure = await runner.run('wrangler', ['--json']).catch((error: Error) => error);
    expect(String(failure)).toContain('diagnostic:');
    expect(String(failure).length).toBeLessThan(4300);
    await expect(runner.run('wrangler', ['--json'], { allowNonzero: true })).resolves.toMatchObject(result);
  });
});
