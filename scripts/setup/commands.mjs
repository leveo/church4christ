import { spawn } from 'node:child_process';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const defaultExec = (file, args, options) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
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
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => finish(reject, error));
  child.stdin.on('error', (error) => finish(reject, error));
  child.on('close', (code) => finish(resolve, { stdout, stderr, exitCode: code ?? 1 }));
  child.stdin.end(options.input ?? '');
});

function redactText(value, secrets) {
  let output = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret !== '') output = output.replaceAll(secret, '[REDACTED]');
  }
  return output;
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
  if (!Array.isArray(options.secretArgIndexes) || options.secretArgIndexes.some((index) =>
    !Number.isInteger(index) || index < 0 || index >= args.length)) {
    throw new TypeError('command secret argument index is invalid');
  }
}

export function createCommandRunner({ exec = defaultExec } = {}) {
  if (typeof exec !== 'function') throw new TypeError('command exec must be a function');
  return Object.freeze({
    async run(file, args, options = {}) {
      validateRun(file, args, options);
      const {
        cwd = process.cwd(),
        env = process.env,
        input,
        secretArgIndexes = [],
        allowNonzero = false,
      } = options;
      const indexSet = new Set(secretArgIndexes);
      const secrets = [
        ...secretArgIndexes.map((index) => args[index]),
        ...(input === undefined ? [] : [input, input.replace(/[\r\n]+$/, '')]),
      ];
      const redactedArgs = args.map((arg, index) => indexSet.has(index) ? '[REDACTED]' : arg);
      const displayCommand = [file, ...redactedArgs].map((part) => JSON.stringify(part)).join(' ');
      let result;
      try {
        result = await exec(file, args, { cwd, env, input, shell: false });
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
