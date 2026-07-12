import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyMediaPlan, loadMediaPlan } from '../../../scripts/setup/media.mjs';

function fakeDb() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  return {
    writes,
    db: {
      prepare(sql: string) {
        return { bind(...values: unknown[]) { return { run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 }, results: [] }; } }; } };
      },
    },
  };
}

describe('shared media setup', () => {
  it('recomputes every content-addressed key in the repository manifest', async () => {
    const plan = loadMediaPlan({ root: process.cwd() });
    expect(plan.assets).toHaveLength(18);
    expect(plan.assets.every((asset: any) => asset.key.startsWith('uploads/'))).toBe(true);
  });

  it('uploads validated objects and performs identical parameterized AppDb writes', async () => {
    const plan = loadMediaPlan({ root: process.cwd() });
    const left = fakeDb();
    const right = fakeDb();
    const upload = vi.fn(async () => undefined);
    await applyMediaPlan({ mediaPlan: plan, db: left.db, uploadObject: upload });
    await applyMediaPlan({ mediaPlan: plan, db: right.db, uploadObject: async () => undefined });
    expect(left.writes).toEqual(right.writes);
    expect(left.writes).toHaveLength(plan.assets.length * 2);
    expect(left.writes.every((entry) => entry.sql.includes('?') && !entry.sql.includes(plan.assets[0].key))).toBe(true);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ key: plan.assets[0].key, filePath: plan.assets[0].filePath, contentType: 'image/webp' }));
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
});
