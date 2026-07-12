import postgres from 'postgres';
import { renderAnonymousBinds } from '../sql.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID = /^[A-Za-z0-9_-]+$/;
const SAFE_PATH = /^(?!-)[^\0\r\n]+$/;
const HEADERS = ['id', 'name', 'user', 'host', 'port', 'scheme', 'database', 'caching', 'mtls', 'origin_connection_limit'];

class PostgresStatement {
  constructor(client, text, params = []) {
    if (typeof text !== 'string' || !text) throw new TypeError('SQL must be a non-empty string');
    this.client = client;
    this.text = text;
    this.params = Object.freeze([...params]);
    Object.freeze(this);
  }
  bind(...values) {
    if (values.some((value) => value === undefined)) throw new TypeError('cannot bind undefined (use null)');
    return new PostgresStatement(this.client, this.text, values);
  }
  async rows(executor = this.client) {
    const translated = renderAnonymousBinds(this.text, this.params, (_value, position) => `$${position}`);
    return executor.unsafe(translated, [...this.params]);
  }
  async first(column) {
    if (column !== undefined && typeof column !== 'string') throw new TypeError('column must be a string');
    const row = (await this.rows())[0] ?? null;
    return row !== null && column !== undefined ? row[column] ?? null : row;
  }
  async all() {
    const rows = await this.rows();
    return { results: rows, meta: { changes: Number.isFinite(rows.count) ? rows.count : 0 }, success: true };
  }
  async run() { return this.all(); }
}

class PostgresSetupDb {
  constructor(client) { this.client = client; Object.freeze(this); }
  prepare(text) { return new PostgresStatement(this.client, text); }
  async batch(statements) {
    if (!Array.isArray(statements) || statements.some((statement) => !(statement instanceof PostgresStatement) || statement.client !== this.client)) {
      throw new TypeError('Postgres batch requires statements prepared by this database');
    }
    return this.client.begin(async (transaction) => {
      const output = [];
      for (const statement of statements) {
        const rows = await statement.rows(transaction);
        output.push({ results: rows, meta: { changes: Number.isFinite(rows.count) ? rows.count : 0 }, success: true });
      }
      return output;
    });
  }
}

/**
 * @param {string} url
 * @param {{ postgresFactory?: (...args: any[]) => any }} [options]
 */
export function openPostgresSetupDb(url, options = {}) {
  const postgresFactory = options.postgresFactory ?? postgres;
  if (typeof url !== 'string' || !url) throw new TypeError('Postgres setup URL is required');
  if (typeof postgresFactory !== 'function') throw new TypeError('postgresFactory must be a function');
  const client = postgresFactory(url, {
    max: 1,
    prepare: false,
    types: { int8AsNumber: { to: 20, from: [20], serialize: String, parse: Number } },
  });
  if (!client || typeof client.unsafe !== 'function' || typeof client.begin !== 'function' || typeof client.end !== 'function') {
    throw new TypeError('Postgres factory returned an invalid client');
  }
  return Object.freeze({ db: new PostgresSetupDb(client), close: async () => { await client.end(); } });
}

function cells(line) {
  if (!/^│.*│$/.test(line)) return null;
  return line.slice(1, -1).split('│').map((cell) => cell.trim());
}

export function parseHyperdriveTable(stdout, exactName) {
  if (typeof stdout !== 'string') throw new TypeError('Hyperdrive list output must be a string');
  const lines = stdout.split(/\r?\n/).filter((line) => line !== '');
  if (lines[0] !== '📋 Listing Hyperdrive configs') throw new Error('Hyperdrive list format changed');
  if (lines.length === 1) return [];
  if (lines.length < 5 || !/^┌[─┬]+┐$/.test(lines[1]) || !/^├[─┼]+┤$/.test(lines[3]) || !/^└[─┴]+┘$/.test(lines.at(-1))) {
    throw new Error('Hyperdrive list table format changed');
  }
  const header = cells(lines[2]);
  if (!header || header.length !== HEADERS.length || header.some((value, index) => value !== HEADERS[index])) {
    throw new Error('Hyperdrive list table headers changed');
  }
  const result = lines.slice(4, -1).map((line) => {
    const row = cells(line);
    if (!row || row.length !== HEADERS.length || !ID.test(row[0]) || !row[1]) {
      throw new Error('Hyperdrive list row format changed');
    }
    return Object.freeze({ id: row[0], name: row[1] });
  });
  if (exactName !== undefined) {
    const matches = result.filter((item) => item.name === exactName);
    if (matches.length > 1) throw new Error(`Hyperdrive name is ambiguous: ${exactName}`);
  }
  return result;
}

function requireHyperdriveOptions(options, requireConnection = false) {
  if (!options || !options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.wranglerBin !== 'string' || !options.wranglerBin) throw new TypeError('wranglerBin is required');
  if (typeof options.configPath !== 'string' || !SAFE_PATH.test(options.configPath)) throw new TypeError('configPath is invalid');
  if (typeof options.name !== 'string' || !NAME.test(options.name)) throw new TypeError('Hyperdrive name is invalid');
  if (requireConnection && (typeof options.connectionString !== 'string' || !options.connectionString)) {
    throw new TypeError('Hyperdrive connection string is required');
  }
}

async function findHyperdrive(options) {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  const result = await options.runner.run(options.wranglerBin,
    ['hyperdrive', 'list', '--config', options.configPath], { env });
  const matches = parseHyperdriveTable(result.stdout, options.name).filter((item) => item.name === options.name);
  return matches[0] ?? null;
}

export async function ensureHyperdrive(options) {
  requireHyperdriveOptions(options);
  let match = await findHyperdrive(options);
  if (match) return Object.freeze({ name: match.name, id: match.id, created: false });
  requireHyperdriveOptions(options, true);
  const args = ['hyperdrive', 'create', options.name, '--connection-string', options.connectionString,
    '--config', options.configPath];
  await options.runner.run(options.wranglerBin, args, { secretArgIndexes: [4] });
  match = await findHyperdrive(options);
  if (!match) throw new Error(`Hyperdrive was not discoverable after create: ${options.name}`);
  return Object.freeze({ name: match.name, id: match.id, created: true });
}
