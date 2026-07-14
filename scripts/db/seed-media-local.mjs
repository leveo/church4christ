#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCommandRunner } from '../setup/commands.mjs';
import { D1CliDb } from '../setup/providers/d1.mjs';
import { renderAnonymousBinds } from '../setup/sql.mjs';
import { applyMediaPlan, loadMediaPlan } from '../setup/media.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const dryRun = process.argv.includes('--dry-run');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(', ')}`);

function readBucketName() {
  if (process.env.MEDIA_BUCKET) return process.env.MEDIA_BUCKET;
  const match = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').match(/"bucket_name"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? 'church4christ-media';
}

function command() {
  const configured = process.env.WRANGLER_BIN;
  const local = join(root, 'node_modules/.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const file = configured || (existsSync(local) ? local : process.platform === 'win32' ? 'npx.cmd' : 'npx');
  return { file, prefix: /(?:^|[/\\])npx(?:\.cmd)?$/.test(file) ? ['wrangler'] : [] };
}

const { file: wranglerBin, prefix } = command();
const persistTo = process.env.WRANGLER_PERSIST_TO;
const runner = createCommandRunner();
const mediaPlan = loadMediaPlan({ root, includePortalFiles: true });
const bucket = readBucketName();

function withPrefix(args) { return [...prefix, ...args, ...(persistTo ? ['--persist-to', persistTo] : [])]; }

if (dryRun) {
  const db = {
    prepare(sql) {
      return { sql, values: [], bind(...values) { return { sql, values }; } };
    },
    async batch(statements) {
      return statements.map((statement) => {
        if (statement.sql.startsWith('SELECT id')) return { results: [{ id: statement.values[0] }], meta: { changes: 0 } };
        console.log(renderAnonymousBinds(statement.sql, statement.values));
        return { results: [], meta: { changes: 1 } };
      });
    },
  };
  await applyMediaPlan({
    mediaPlan,
    db,
    uploadObject: async ({ key, filePath, contentType }) => console.log([wranglerBin, ...withPrefix(['r2', 'object', 'put', `${bucket}/${key}`, '--file', filePath, '--content-type', contentType, '--local', '--force'])].join(' ')),
  });
} else {
  const db = new D1CliDb({ runner: { run: (ignored, args, options) => runner.run(wranglerBin, [...prefix, ...args], options) }, wranglerBin, configPath: 'wrangler.jsonc', mode: 'local', persistTo });
  await applyMediaPlan({
    mediaPlan,
    db,
    uploadObject: ({ key, filePath, contentType }) => runner.run(wranglerBin, withPrefix(['r2', 'object', 'put', `${bucket}/${key}`, '--file', filePath, '--content-type', contentType, '--local', '--force'])),
  });
  console.log(`Seeded ${mediaPlan.assets.length} media assets and ${mediaPlan.objects.length} portal files into local R2 and D1`);
}
