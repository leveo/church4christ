import { afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, lstat, mkdtemp, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const SOURCE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cleanupRoots = new Set<string>();
const EXCLUDED_NAMES = new Set([
  '.git', 'node_modules', '.wrangler', '.astro', 'dist', '.dev.vars', '.church',
  'output', 'church.config.json', '.worktrees',
]);

function canCopy(source: string) {
  const rel = relative(SOURCE_ROOT, source);
  if (!rel || rel.startsWith(`..${sep}`)) return true;
  return !rel.split(sep).some((part) => EXCLUDED_NAMES.has(part));
}

export type CleanWorkspace = {
  root: string;
  execNode(args: string[], env?: Environment, timeout?: number): Promise<{ stdout: string; stderr: string }>;
};
type Environment = Record<string, string | undefined>;
type RunningChild = ChildProcess & { stdout: Readable; stderr: Readable };
const spawnFailures = new WeakMap<ChildProcess, Error>();
const SECRET_ENV = /^(?:DATABASE_URL|SUPABASE(?:_|$)|STRIPE(?:_|$)|CLOUDFLARE(?:_|$)|CF_|D1_|SESSION_SECRET$|AUTH_|EMAIL_|WRANGLER_)/;

export function childEnvironment(explicit: Environment = {}) {
  const clean: Environment = {};
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_ENV.test(key)) clean[key] = value;
  return { ...clean, ...explicit };
}

export async function createCleanWorkspace(): Promise<CleanWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'church-cms-setup-'));
  cleanupRoots.add(root);
  await cp(SOURCE_ROOT, root, {
    recursive: true,
    dereference: false,
    filter: canCopy,
  });
  await symlink(join(SOURCE_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  return {
    root,
    execNode: (args, env = {}, timeout = 120_000) => runProcess(root, process.execPath, [join(root, 'scripts/setup/index.mjs'), ...args], env, timeout, 16 * 1024 * 1024),
  };
}

export async function workspaceHash(root: string) {
  const entries: string[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        entries.push(`link:${rel}:${await readlink(path)}`);
      } else if (stat.isDirectory()) {
        entries.push(`dir:${rel}`);
        await visit(path);
      } else if (stat.isFile()) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex');
        entries.push(`file:${rel}:${digest}`);
      }
    }
  }
  await visit(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export async function listRelativePaths(root: string) {
  const paths: string[] = [];
  async function visit(directory: string) {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
    for (const name of names.sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      paths.push(rel);
      const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(path);
    }
  }
  await visit(root);
  return paths.sort();
}

export async function execWorkspace(root: string, file: string, args: string[], env: Environment = {}, timeout = 180_000) {
  return runProcess(root, file, args, env, timeout, 32 * 1024 * 1024);
}

export async function waitForHttp(url: string, child: RunningChild, output: () => string, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const spawnFailure = spawnFailures.get(child);
    if (spawnFailure) throw new Error(`dev server failed to spawn before ${url} became ready: ${spawnFailure.message}\n${output()}`, { cause: spawnFailure });
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`dev server exited before ${url} became ready\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolveDone) => setTimeout(resolveDone, 250));
  }
  throw new Error(`timed out waiting for ${url}\n${output()}`);
}

export function spawnWorkspace(root: string, command: string, args: string[], env: Environment = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: childEnvironment(env) as unknown as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as unknown as RunningChild;
  child.once('error', (error) => spawnFailures.set(child, error));
  return child;
}

async function runProcess(root: string, file: string, args: string[], env: Environment, timeout: number, maxBytes: number) {
  const child = spawnWorkspace(root, file, args, env);
  let stdout = ''; let stderr = ''; let bytes = 0; let settled = false; let abortOutput = () => {};
  const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
    const text = String(chunk); bytes += Buffer.byteLength(text);
    if (bytes <= maxBytes) { if (kind === 'stdout') stdout += text; else stderr += text; }
    else abortOutput();
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));
  return new Promise<{ stdout: string; stderr: string }>((resolveDone, reject) => {
    const fail = async (message: string, cause?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      await stopChild(child).catch(() => {});
      reject(new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`, cause ? { cause } : undefined));
    };
    abortOutput = () => void fail(`${file} exceeded ${maxBytes} output bytes`);
    child.once('error', (error) => void fail(`${file} failed to spawn`, error));
    child.once('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (bytes > maxBytes) reject(new Error(`${file} exceeded ${maxBytes} output bytes\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      else if (code === 0) resolveDone({ stdout, stderr });
      else reject(new Error(`${file} child failed (${code ?? signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    const timer = setTimeout(() => void fail(`${file} timed out after ${timeout}ms`), timeout);
  });
}

export async function allocatePort() {
  const server = createServer();
  await new Promise<void>((resolveDone, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveDone()); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveDone, reject) => server.close((error) => error ? reject(error) : resolveDone()));
  if (!port) throw new Error('failed to allocate a local port');
  return port;
}

export async function cleanupAll(tasks: Array<() => Promise<unknown>>, _primaryError?: unknown) {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  return results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
}

export async function stopChild(child: RunningChild) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else if (child.pid) process.kill(-child.pid, name);
      else return false;
      return true;
    } catch (error: any) {
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  };
  const waitForExit = (timeout: number) => new Promise<boolean>((resolveDone) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolveDone(true); return; }
    const done = () => { clearTimeout(timer); child.off('exit', done); resolveDone(true); };
    const timer = setTimeout(() => { child.off('exit', done); resolveDone(false); }, timeout);
    child.once('exit', done);
  });
  const termSent = signal('SIGTERM');
  if (!termSent) { await waitForExit(1_000); return; }
  await waitForExit(5_000);
  if (child.exitCode === null && child.signalCode === null) {
    const killSent = signal('SIGKILL');
    const exited = await waitForExit(5_000);
    if (killSent && !exited && child.exitCode === null && child.signalCode === null) {
      throw new Error('dev server process group did not exit after SIGKILL');
    }
  }
}

afterEach(async () => {
  const roots = [...cleanupRoots];
  cleanupRoots.clear();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
