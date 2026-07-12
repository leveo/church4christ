import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyMediaPlan, loadMediaPlan } from '../../../scripts/setup/media.mjs';

function fakeDb() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const batches: any[][] = [];
  return {
    writes, batches,
    db: {
      prepare(sql: string) {
        return { sql, values: [] as unknown[], bind(...values: unknown[]) { return { sql, values }; } };
      },
      async batch(statements: any[]) {
        batches.push(statements);
        const isPreflight = statements.every((statement) => statement.sql.startsWith('SELECT id'));
        if (!isPreflight) writes.push(...statements);
        return statements.map((statement) => isPreflight
          ? { meta: { changes: 0 }, results: [{ id: statement.values[0] }] }
          : { meta: { changes: 1 }, results: [] });
      },
    },
  };
}

describe('shared media setup', () => {
  it('recomputes every content-addressed key in the repository manifest', async () => {
    const plan = loadMediaPlan({ root: process.cwd() });
    expect(plan.assets).toHaveLength(18);
    expect(plan.assets.every((asset: any) => asset.key.startsWith('uploads/'))).toBe(true);
    expect(plan.assets.every((asset: any) => typeof asset.contentBase64 === 'string' && !('filePath' in asset))).toBe(true);
  });

  it('uploads validated objects and performs identical parameterized AppDb writes', async () => {
    const plan = loadMediaPlan({ root: process.cwd() });
    const left = fakeDb();
    const right = fakeDb();
    const upload = vi.fn(async (_input: { key: string; filePath: string; contentType: string }) => undefined);
    await applyMediaPlan({ mediaPlan: plan, db: left.db, uploadObject: upload });
    await applyMediaPlan({ mediaPlan: plan, db: right.db, uploadObject: async () => undefined });
    expect(left.writes).toEqual(right.writes);
    expect(left.writes).toHaveLength(plan.assets.length * 2);
    expect(left.batches).toHaveLength(2);
    expect(right.batches).toHaveLength(2);
    expect(left.writes.every((entry) => entry.sql.includes('?') && !entry.sql.includes(plan.assets[0].key))).toBe(true);
    const staged = upload.mock.calls[0][0].filePath;
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ key: plan.assets[0].key, contentType: 'image/webp' }));
    await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses validated bytes even if the original file changes after planning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-media-bytes-'));
    await mkdir(join(root, 'seed/media'), { recursive: true });
    const file = join(root, 'seed/media/a.webp');
    await writeFile(file, 'original');
    const { createHash } = await import('node:crypto');
    const key = `uploads/${createHash('sha256').update('original').digest('hex').slice(0, 16)}-a.webp`;
    await writeFile(join(root, 'seed/media/manifest.json'), JSON.stringify({ version: 1, generatedWith: 'test', contentType: 'image/webp', uploadedBy: 'a@b.test', assets: [{ file: 'a.webp', key, target: { type: 'setting', key: 'site.hero' } }] }));
    const plan = loadMediaPlan({ root });
    await writeFile(file, 'tampered');
    const seen: Buffer[] = [];
    await applyMediaPlan({ mediaPlan: plan, db: fakeDb().db, uploadObject: async ({ filePath }: any) => { seen.push(await readFile(filePath)); } });
    expect(seen[0].toString()).toBe('original');
  });

  it('preflights every relational target before uploading or writing', async () => {
    const plan = loadMediaPlan({ root: process.cwd() });
    const db = fakeDb();
    db.db.batch = vi.fn(async (statements: any[]) => statements.map((_statement, index) => ({ meta: { changes: 0 }, results: index === statements.length - 1 ? [] : [{ id: 1 }] }))) as any;
    const upload = vi.fn();
    await expect(applyMediaPlan({ mediaPlan: plan, db: db.db, uploadObject: upload })).rejects.toThrow(/target.*exist/i);
    expect(upload).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
    expect(db.db.batch).toHaveBeenCalledTimes(1);
  });

  it('rejects traversal, symlinks, invalid keys, content types, and targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-media-'));
    await mkdir(join(root, 'seed/media'), { recursive: true });
    await writeFile(join(root, 'outside.webp'), 'x');
    await symlink(join(root, 'outside.webp'), join(root, 'seed/media/link.webp'));
    const writeManifest = (asset: unknown, contentType = 'image/webp') => writeFile(join(root, 'seed/media/manifest.json'), JSON.stringify({ version: 1, generatedWith: 'test', contentType, uploadedBy: 'a@b.test', assets: [asset] }));
    for (const asset of [
      { file: '../outside.webp', key: 'uploads/bad-outside.webp', target: { type: 'setting', key: 'x' } },
      { file: 'link.webp', key: 'uploads/bad-link.webp', target: { type: 'setting', key: 'x' } },
      { file: 'x.webp', key: '../bad', target: { type: 'setting', key: 'x' } },
      { file: 'x.webp', key: 'uploads/bad-x.webp', target: { type: 'event', id: 0 } },
    ]) {
      await writeManifest(asset);
      await expect(async () => loadMediaPlan({ root })).rejects.toThrow();
    }
    await writeManifest({ file: 'x.webp', key: 'uploads/bad-x.webp', target: { type: 'setting', key: 'x' } }, 'text/html');
    await expect(async () => loadMediaPlan({ root })).rejects.toThrow(/content type/i);
    expect(await readFile(join(root, 'outside.webp'), 'utf8')).toBe('x');
  });

  it('requires an absolute root', () => {
    expect(() => loadMediaPlan({ root: '.' })).toThrow(/absolute/i);
  });
});
