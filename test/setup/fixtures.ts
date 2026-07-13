import { afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, lstat, mkdtemp, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
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
    execNode: async (args, env = {}, timeout = 120_000) => {
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [join(root, 'scripts/setup/index.mjs'), ...args], {
          cwd: root,
          env: { ...process.env, ...env },
          encoding: 'utf8',
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { stdout, stderr };
      } catch (error: any) {
        throw new Error(`setup child failed\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`, { cause: error });
      }
    },
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
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error: any) {
    throw new Error(`${file} child failed\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`, { cause: error });
  }
}

export async function waitForHttp(url: string, child: RunningChild, output: () => string, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
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
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as unknown as RunningChild;
}

export async function stopChild(child: RunningChild) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid!, name);
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
