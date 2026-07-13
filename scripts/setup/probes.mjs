import { parseHyperdriveTable } from './providers/postgres.mjs';

const commandResult = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.stdout === 'string' && typeof value.stderr === 'string' && Number.isInteger(value.exitCode);

export function parseWorkerDeployments(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error('Worker deployments returned malformed JSON'); }
  if (!Array.isArray(value) || value.length === 0 || value.some((deployment) =>
    !deployment || typeof deployment !== 'object' || Array.isArray(deployment) ||
    typeof deployment.id !== 'string' || !deployment.id ||
    typeof deployment.created_on !== 'string' || Number.isNaN(Date.parse(deployment.created_on)) ||
    !Array.isArray(deployment.versions) || deployment.versions.length === 0 ||
    deployment.versions.some((version) => !version || typeof version !== 'object' ||
      typeof version.version_id !== 'string' || !version.version_id ||
      typeof version.percentage !== 'number' || version.percentage < 0 || version.percentage > 100))) {
    throw new Error('Worker deployments returned invalid or empty JSON');
  }
  return value;
}

function parseD1List(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error('D1 list returned malformed JSON'); }
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object' ||
      typeof entry.name !== 'string' || typeof entry.uuid !== 'string')) throw new Error('D1 list returned invalid JSON');
  return value;
}

async function run(options, args, extra = {}) {
  if (!options?.runner || typeof options.runner.run !== 'function') throw new TypeError('probe runner.run is required');
  const result = await options.runner.run(options.wranglerBin, args, extra);
  if (!commandResult(result) || result.exitCode !== 0) throw new Error(`Read-only Wrangler probe failed: ${args.slice(0, 2).join(' ')}`);
  return result;
}

export async function probeR2Object(options) {
  const args = ['r2', 'object', 'get', `${options.bucket}/${options.key}`, '--pipe', options.mode === 'deploy' ? '--remote' : '--local', '--config', options.configPath];
  const result = await options.runner.run(options.wranglerBin, args, { allowNonzero: true, maxOutputBytes: 8 * 1024 * 1024 });
  if (!commandResult(result)) throw new Error('R2 object probe returned an invalid command result');
  if (result.exitCode === 0) return true;
  if (/not found|does not exist|\b404\b/i.test(`${result.stdout}\n${result.stderr}`)) return false;
  throw new Error('R2 object probe failed');
}

export async function probeDeployResources(options) {
  const { manifest } = options;
  if (manifest?.mode !== undefined && manifest.mode !== 'deploy') throw new TypeError('deploy resource probe requires deploy mode');
  let workerReady = false;
  if (options.probeWorker !== false) {
    const worker = await run(options, ['deployments', 'status', '--name', manifest.site.slug, '--json', '--config', options.configPath]);
    parseWorkerDeployments(JSON.stringify([JSON.parse(worker.stdout)]));
    workerReady = true;
  }
  const bucket = await run(options, ['r2', 'bucket', 'info', manifest.resources.r2BucketName, '--json', '--config', options.configPath]);
  let bucketJson;
  try { bucketJson = JSON.parse(bucket.stdout); } catch { throw new Error('R2 bucket probe returned malformed JSON'); }
  if (!bucketJson || typeof bucketJson !== 'object' || Array.isArray(bucketJson) || bucketJson.name !== manifest.resources.r2BucketName) throw new Error('R2 bucket probe name mismatch');
  if (manifest.database === 'd1') {
    const databases = parseD1List((await run(options, ['d1', 'list', '--json', '--config', options.configPath])).stdout);
    const matches = databases.filter((entry) => entry.name === manifest.resources.d1DatabaseName && entry.uuid === manifest.resources.d1DatabaseId);
    if (matches.length !== 1) throw new Error('D1 resource ID/name mismatch');
    return Object.freeze({ worker: workerReady, r2: true, d1: true, hyperdrive: false });
  }
  const listed = await run(options, ['hyperdrive', 'list', '--config', options.configPath], { env: { ...process.env, WRANGLER_HIDE_BANNER: 'true', NO_COLOR: '1', FORCE_COLOR: '0' } });
  const matches = parseHyperdriveTable(listed.stdout, `${manifest.site.slug}-db`)
    .filter((entry) => entry.name === `${manifest.site.slug}-db` && entry.id === manifest.resources.hyperdriveId);
  if (matches.length !== 1) throw new Error('Hyperdrive resource ID/name mismatch');
  return Object.freeze({ worker: workerReady, r2: true, d1: false, hyperdrive: true });
}
