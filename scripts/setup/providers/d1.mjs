import { renderAnonymousBinds } from '../sql.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID = /^[A-Za-z0-9_-]+$/;
const SAFE_PATH = /^(?!-)[^\0\r\n]+$/;
const CHANGES_BEFORE = '__c4c_total_changes_before_8d4f2b';
const CHANGES_AFTER = '__c4c_total_changes_after_8d4f2b';
const beforeSql = `SELECT total_changes() AS "${CHANGES_BEFORE}"`;
const afterSql = `SELECT total_changes() AS "${CHANGES_AFTER}"`;

function requireOptions({ runner, wranglerBin, configPath, name }) {
  if (!runner || typeof runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof wranglerBin !== 'string' || !wranglerBin) throw new TypeError('wranglerBin is required');
  if (typeof configPath !== 'string' || !SAFE_PATH.test(configPath)) throw new TypeError('configPath is invalid');
  if (name !== undefined && (typeof name !== 'string' || !NAME.test(name))) throw new TypeError('resource name is invalid');
}

function normalizeD1(stdout, expectedCount) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('Wrangler D1 returned malformed JSON'); }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const normalized = entries.map((result) => {
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.success !== true ||
        !Array.isArray(result.results) || !result.meta || typeof result.meta !== 'object' || Array.isArray(result.meta)) {
      throw new Error('Wrangler D1 returned an invalid or unsuccessful result');
    }
    const changes = result.meta.changes ?? 0;
    if (typeof changes !== 'number' || !Number.isFinite(changes)) throw new Error('Wrangler D1 returned invalid metadata');
    return Object.freeze({ results: result.results, meta: { ...result.meta, changes }, success: true });
  });
  if (normalized.length !== expectedCount) throw new Error(`Wrangler D1 returned ${normalized.length} results; expected ${expectedCount}`);
  return normalized;
}

function totalChanges(result, alias) {
  if (result.results.length !== 1) throw new Error('Wrangler D1 returned invalid total_changes result');
  const row = result.results[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 1 ||
      !Object.hasOwn(row, alias) || !Number.isFinite(row[alias]) || row[alias] < 0) {
    throw new Error('Wrangler D1 returned invalid total_changes result');
  }
  return row[alias];
}

class D1Statement {
  constructor(db, sql, params = []) {
    if (typeof sql !== 'string' || !sql) throw new TypeError('SQL must be a non-empty string');
    this.db = db;
    this.sql = sql;
    this.params = Object.freeze([...params]);
    Object.freeze(this);
  }
  bind(...values) { return new D1Statement(this.db, this.sql, values); }
  async all() { return this.db.execute(renderAnonymousBinds(this.sql, this.params)); }
  async first(column) {
    if (column !== undefined && typeof column !== 'string') throw new TypeError('column must be a string');
    const row = (await this.all()).results[0] ?? null;
    return row !== null && column !== undefined ? row[column] ?? null : row;
  }
  async run() { return this.all(); }
}

export class D1CliDb {
  constructor(options) {
    const { runner, wranglerBin, configPath, mode, persistTo } = options;
    requireOptions({ runner, wranglerBin, configPath });
    if (mode !== 'local' && mode !== 'deploy') throw new TypeError('D1 setup mode must be local or deploy');
    if (persistTo !== undefined && (mode !== 'local' || typeof persistTo !== 'string' || !SAFE_PATH.test(persistTo))) {
      throw new TypeError('persistTo is supported only as a non-empty local path');
    }
    Object.assign(this, { runner, wranglerBin, configPath, mode, persistTo });
    Object.freeze(this);
  }
  prepare(sql) { return new D1Statement(this, sql); }
  async batch(statements) {
    if (!Array.isArray(statements) || statements.some((statement) => !(statement instanceof D1Statement) || statement.db !== this)) {
      throw new TypeError('D1 batch requires statements prepared by this database');
    }
    if (statements.length === 0) return [];
    const sql = statements.map((statement) => renderAnonymousBinds(statement.sql, statement.params));
    return this.executeStatements(sql);
  }
  async execute(sql) {
    return (await this.executeStatements([sql]))[0];
  }
  async executeStatements(statements) {
    if (!Array.isArray(statements) || statements.length === 0 || statements.some((sql) => typeof sql !== 'string' || !sql)) {
      throw new TypeError('SQL statements must be non-empty strings');
    }
    const sql = statements.flatMap((statement) => [beforeSql, statement, afterSql]).join('\n;\n');
    const args = ['d1', 'execute', 'DB', this.mode === 'deploy' ? '--remote' : '--local',
      '--command', sql, '--json', '--yes', '--config', this.configPath];
    if (this.persistTo) args.push('--persist-to', this.persistTo);
    const raw = normalizeD1((await this.runner.run(this.wranglerBin, args)).stdout, statements.length * 3);
    return statements.map((_statement, index) => {
      const before = totalChanges(raw[index * 3], CHANGES_BEFORE);
      const middle = raw[index * 3 + 1];
      const after = totalChanges(raw[index * 3 + 2], CHANGES_AFTER);
      const changes = after - before;
      if (!Number.isFinite(changes) || changes < 0) throw new Error('Wrangler D1 returned invalid total_changes delta');
      return Object.freeze({ results: middle.results, meta: { ...middle.meta, changes }, success: true });
    });
  }
}

function parseD1List(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('Wrangler D1 list returned malformed JSON'); }
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.name !== 'string' || typeof item.uuid !== 'string' || !ID.test(item.uuid))) {
    throw new Error('Wrangler D1 list returned invalid JSON');
  }
  return parsed;
}

async function findD1(options) {
  const result = await options.runner.run(options.wranglerBin, ['d1', 'list', '--json', '--config', options.configPath]);
  const matches = parseD1List(result.stdout).filter((item) => item.name === options.name);
  if (matches.length > 1) throw new Error(`D1 database name is ambiguous: ${options.name}`);
  return matches[0] ?? null;
}

export async function ensureD1Database(options) {
  requireOptions(options);
  let match = await findD1(options);
  if (match) return Object.freeze({ name: match.name, id: match.uuid, created: false });
  await options.runner.run(options.wranglerBin, ['d1', 'create', options.name, '--config', options.configPath]);
  match = await findD1(options);
  if (!match) throw new Error(`D1 database was not discoverable after create: ${options.name}`);
  return Object.freeze({ name: match.name, id: match.uuid, created: true });
}

function isR2NotFound(result) {
  return result.exitCode !== 0 && /(?:\b404\b|not found|does not exist)/i.test(`${result.stdout}\n${result.stderr}`) &&
    !/(?:auth|unauthor|forbidden|permission|credential|token)/i.test(`${result.stdout}\n${result.stderr}`);
}

async function probeR2(options) {
  const result = await options.runner.run(options.wranglerBin,
    ['r2', 'bucket', 'info', options.name, '--json', '--config', options.configPath], { allowNonzero: true });
  if (result.exitCode !== 0) {
    if (isR2NotFound(result)) return null;
    throw new Error(`R2 bucket probe failed for ${options.name}: ${result.stderr}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Wrangler R2 info returned malformed JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.name !== options.name) {
    throw new Error(`Wrangler R2 info name mismatch for ${options.name}`);
  }
  return parsed;
}

export async function ensureR2Bucket(options) {
  requireOptions(options);
  if (await probeR2(options)) return Object.freeze({ name: options.name, created: false });
  await options.runner.run(options.wranglerBin, ['r2', 'bucket', 'create', options.name, '--config', options.configPath]);
  if (!await probeR2(options)) throw new Error(`R2 bucket was not discoverable after create: ${options.name}`);
  return Object.freeze({ name: options.name, created: true });
}
