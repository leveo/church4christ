#!/usr/bin/env node
// v1.0.0 release rehearsal. It never fetches, deploys, publishes, or targets a
// configured application database: both backends are built inside disposable
// isolation owned by this process.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE_COMMIT = 'b85ad362b9f879408797270929c52dab7ad39d1d';

export async function assertBaseline(value, runner = async (file, args) => {
  try { await exec(file, args, { cwd: ROOT }); return { exitCode: 0 }; } catch { return { exitCode: 1 }; }
}) {
  if (value !== BASELINE_COMMIT) throw new Error('upgrade rehearsal baseline is not allowlisted');
  const checked = await runner('git', ['cat-file', '-e', `${BASELINE_COMMIT}^{commit}`]);
  if (checked.exitCode !== 0) throw new Error('baseline commit is absent; checkout must use fetch-depth: 0');
}

export function randomSchemaName() {
  return `c4c_rehearsal_${randomBytes(8).toString('hex')}`;
}

export function assertDisposablePostgresUrl(raw) {
  const url = new URL(raw);
  if (url.searchParams.get('c4c_rehearsal') !== '1') throw new Error('PostgreSQL rehearsal target requires c4c_rehearsal=1 marker');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('PostgreSQL rehearsal target must be local');
  if (!/(?:^|_)test(?:$|_)/i.test(url.pathname.slice(1))) throw new Error('PostgreSQL rehearsal database must be test-marked');
}

async function runWithInput(file, args, input, cwd = ROOT) {
  await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? accept() : reject(new Error(`${file} failed (${code}): ${error.slice(0, 500)}`)));
    child.stdin.end(input);
  });
}

async function sqlFiles(directory) {
  return (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

async function archiveBaseline(target) {
  const tarPath = join(target, 'baseline.tar');
  const { stdout } = await exec('git', ['archive', '--format=tar', BASELINE_COMMIT], { cwd: ROOT, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
  await writeFile(tarPath, stdout);
  const checkout = join(target, 'baseline');
  await mkdir(checkout);
  await exec('tar', ['-xf', tarPath, '-C', checkout]);
  return checkout;
}

async function rehearseD1(baselineRoot, target) {
  const database = join(target, 'upgrade.sqlite3');
  const baselineFiles = await sqlFiles(join(baselineRoot, 'migrations'));
  const currentFiles = await sqlFiles(join(ROOT, 'migrations'));
  for (const name of baselineFiles) await runWithInput('sqlite3', [database], await readFile(join(baselineRoot, 'migrations', name), 'utf8'));
  await runWithInput('sqlite3', [database], "INSERT INTO people(id,display_name,email,role,super_admin) VALUES(2147483000,'Rehearsal canary','rehearsal@example.invalid','admin',1);\nINSERT INTO settings(key,value) VALUES('release.rehearsal','baseline');");
  for (const name of currentFiles.filter((name) => !baselineFiles.includes(name))) await runWithInput('sqlite3', [database], await readFile(join(ROOT, 'migrations', name), 'utf8'));
  const verified = await exec('sqlite3', [database, "SELECT CASE WHEN EXISTS(SELECT 1 FROM people WHERE id=2147483000) AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='onboarding_acknowledgements') THEN 'ready' ELSE 'failed' END"]);
  if (verified.stdout.trim() !== 'ready') throw new Error('D1 upgrade canary/readiness failed');
}

function isolatePgSql(source, schema) {
  return source
    .replaceAll('church_private.', `${schema}.`)
    .replaceAll('public.', `${schema}.`)
    .replace(/CREATE SCHEMA IF NOT EXISTS church_private/gi, `CREATE SCHEMA IF NOT EXISTS ${schema}`);
}

async function rehearsePostgres(baselineRoot, connectionString) {
  assertDisposablePostgresUrl(connectionString);
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, { max: 1, fetch_types: false, prepare: false, onnotice: () => {} });
  const schema = randomSchemaName();
  try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    const baselineFiles = await sqlFiles(join(baselineRoot, 'migrations-supabase'));
    const currentFiles = await sqlFiles(join(ROOT, 'migrations-supabase'));
    for (const name of baselineFiles) await sql.unsafe(isolatePgSql(await readFile(join(baselineRoot, 'migrations-supabase', name), 'utf8'), schema));
    await sql.unsafe("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(2147483000,'Rehearsal canary','rehearsal@example.invalid','admin',1); INSERT INTO settings(key,value) VALUES('release.rehearsal','baseline')");
    for (const name of currentFiles.filter((name) => !baselineFiles.includes(name))) await sql.unsafe(isolatePgSql(await readFile(join(ROOT, 'migrations-supabase', name), 'utf8'), schema));
    const rows = await sql.unsafe("SELECT to_regclass('onboarding_acknowledgements') IS NOT NULL AS readiness, EXISTS(SELECT 1 FROM people WHERE id=2147483000) AS canary");
    if (!rows[0]?.readiness || !rows[0]?.canary) throw new Error('PostgreSQL upgrade canary/readiness failed');
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await sql.end();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const unexpected = argv.filter((arg) => arg !== '--d1' && arg !== '--pg');
  if (unexpected.length || !argv.length) throw new Error('usage: rehearse-upgrade.mjs --d1 [--pg]');
  await assertBaseline(BASELINE_COMMIT);
  const temp = await mkdtemp(join(tmpdir(), 'c4c-v1-upgrade-'));
  try {
    const baselineRoot = await archiveBaseline(temp);
    if (argv.includes('--d1')) await rehearseD1(baselineRoot, temp);
    if (argv.includes('--pg')) {
      const url = process.env.C4C_REHEARSAL_DATABASE_URL;
      if (!url) throw new Error('C4C_REHEARSAL_DATABASE_URL is required for --pg');
      await rehearsePostgres(baselineRoot, url);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
