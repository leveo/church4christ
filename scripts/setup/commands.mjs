import { spawn } from 'node:child_process';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_ENV_NAME = /(?:SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL|CONNECTION_STRING)/i;
const SCRUBBED_STRIPE_ENV_KEYS = Object.freeze([
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_MODE',
  'CHURCH_SETUP_STRIPE_SECRET_KEY',
  'CHURCH_SETUP_STRIPE_WEBHOOK_SECRET',
]);

function scrubbedChildEnvironment(environment) {
  const env = { ...environment };
  for (const key of SCRUBBED_STRIPE_ENV_KEYS) delete env[key];
  return env;
}

const defaultExec = (file, args, options) => new Promise((resolve, reject) => {
  let settled = false;
  let timer;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(value);
  };
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  const collect = (target, chunk) => {
    if (settled) return target;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > options.maxOutputBytes) {
      child.kill('SIGKILL');
      finish(reject, new Error(`command output limit exceeded (${options.maxOutputBytes} bytes)`));
      return target;
    }
    return target + chunk;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
  child.on('error', (error) => finish(reject, error));
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') finish(reject, error); });
  child.on('close', (code) => finish(resolve, { stdout, stderr, exitCode: code ?? 1 }));
  timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(reject, new Error(`command timed out after ${options.timeoutMs}ms`));
  }, options.timeoutMs);
  timer.unref?.();
  child.stdin.end(options.input ?? '');
});

function redactText(value, secrets) {
  let output = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret !== '') output = output.replaceAll(secret, '[REDACTED]');
  }
  return output;
}

function secretVariants(values) {
  const found = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || value === '' || found.has(value)) return;
    found.add(value);
    try { found.add(decodeURIComponent(value)); } catch {}
    found.add(encodeURIComponent(value));
  };
  const addUrl = (value) => {
    if (typeof value !== 'string' || !/^\w+:\/\//.test(value)) return;
    try {
      const url = new URL(value);
      add(url.username); add(url.password);
      for (const queryValue of url.searchParams.values()) add(queryValue);
    } catch {}
  };
  for (const value of values) { add(value); addUrl(value); }
  return [...found].filter(Boolean);
}

function validateRun(file, args, options) {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('command file must be a non-empty string');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('command arguments must be an array of strings');
  }
  if (!isRecord(options)) throw new TypeError('command options must be an object');
  if (options.cwd !== undefined && typeof options.cwd !== 'string') throw new TypeError('command cwd must be a string');
  if (options.env !== undefined && !isRecord(options.env)) throw new TypeError('command env must be an object');
  if (options.input !== undefined && typeof options.input !== 'string') throw new TypeError('command input must be a string');
  if (options.allowNonzero !== undefined && typeof options.allowNonzero !== 'boolean') {
    throw new TypeError('command allowNonzero must be a boolean');
  }
  for (const [key, fallback] of [['maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES], ['timeoutMs', DEFAULT_TIMEOUT_MS]]) {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`command ${key} must be a positive safe integer`);
  }
  if (options.secretValues !== undefined && (!Array.isArray(options.secretValues) || options.secretValues.some((value) => typeof value !== 'string'))) {
    throw new TypeError('command secretValues must be an array of strings');
  }
  if (options.secretEnvKeys !== undefined && (!Array.isArray(options.secretEnvKeys) || options.secretEnvKeys.some((value) => typeof value !== 'string'))) {
    throw new TypeError('command secretEnvKeys must be an array of strings');
  }
  const secretArgIndexes = options.secretArgIndexes ?? [];
  if (!Array.isArray(secretArgIndexes) || secretArgIndexes.some((index) =>
    !Number.isInteger(index) || index < 0 || index >= args.length)) {
    throw new TypeError('command secret argument index is invalid');
  }
}

export function createCommandRunner({ exec = defaultExec, secretValues: registeredSecretValues = /** @type {string[]} */ ([]) } = {}) {
  if (typeof exec !== 'function') throw new TypeError('command exec must be a function');
  if (!Array.isArray(registeredSecretValues) || registeredSecretValues.some((value) => typeof value !== 'string')) {
    throw new TypeError('registered command secretValues must be a string array');
  }
  return Object.freeze({
    async run(file, args, options = {}) {
      validateRun(file, args, options);
      const {
        cwd = process.cwd(),
        env: requestedEnv = process.env,
        input,
        secretArgIndexes = [],
        allowNonzero = false,
        maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        secretValues: commandSecretValues = [],
        secretEnvKeys = [],
      } = options;
      const env = scrubbedChildEnvironment(requestedEnv);
      const indexSet = new Set(secretArgIndexes);
      const inputParts = input === undefined ? [] : [input, ...input.split(/\r?\n/).flatMap((line) => {
        const trimmed = line.trim();
        const equals = trimmed.indexOf('=');
        return [trimmed, ...(equals >= 0 ? [trimmed.slice(equals + 1)] : [])];
      })];
      const envSecrets = Object.entries(env).filter(([key, value]) =>
        typeof value === 'string' && (SECRET_ENV_NAME.test(key) || secretEnvKeys.includes(key))).map(([, value]) => value);
      const secrets = secretVariants([
        ...secretArgIndexes.map((index) => args[index]),
        ...inputParts, ...registeredSecretValues, ...commandSecretValues, ...envSecrets,
      ]);
      const redactedArgs = args.map((arg, index) => indexSet.has(index) ? '[REDACTED]' : arg);
      const displayCommand = [file, ...redactedArgs].map((part) => JSON.stringify(part)).join(' ');
      let result;
      try {
        result = await exec(file, args, { cwd, env, input, shell: false, maxOutputBytes, timeoutMs });
      } catch (error) {
        const message = redactText(error instanceof Error ? error.message : error, secrets);
        throw new Error(`${displayCommand} failed to start: ${message}`);
      }
      if (!isRecord(result) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
          !Number.isInteger(result.exitCode)) {
        throw new Error(`${displayCommand} returned an invalid command result`);
      }
      const safe = Object.freeze({
        stdout: redactText(result.stdout, secrets),
        stderr: redactText(result.stderr, secrets),
        exitCode: result.exitCode,
        displayCommand,
      });
      if (safe.exitCode !== 0 && !allowNonzero) {
        throw new Error(`${displayCommand} failed (${safe.exitCode}): ${safe.stderr}`);
      }
      return safe;
    },
  });
}
