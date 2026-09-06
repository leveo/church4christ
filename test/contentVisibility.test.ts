import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { includeDemoContent } from '../src/lib/contentVisibility';
import { scopeDatabase } from '../src/lib/campusScope';
import { setSetting } from '../src/lib/settings';

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'site.demo_content'").run();
  await env.DB.prepare('DELETE FROM campuses WHERE id IN (89001, 89002)').run();
});

describe('request-scoped demo visibility', () => {
  it('preserves legacy content when the setting is absent', async () => {
    expect(await includeDemoContent(env.DB)).toBe(true);
  });

  it('honors the current installation setting without caching it across requests', async () => {
    await setSetting(env.DB, 'site.demo_content', 'false');
    expect(await includeDemoContent(env.DB)).toBe(false);
    await setSetting(env.DB, 'site.demo_content', 'true');
    expect(await includeDemoContent(env.DB)).toBe(true);
  });

  it('uses the selected campus setting without reading another campus configuration', async () => {
    await env.DB.prepare(`INSERT INTO campuses (id, slug, name) VALUES
      (89001, 'empty-content', 'Empty Content'), (89002, 'demo-content', 'Demo Content')`).run();
    const empty = scopeDatabase(env.DB, 89001);
    const demo = scopeDatabase(env.DB, 89002);
    await setSetting(empty, 'site.demo_content', 'false');
    await setSetting(demo, 'site.demo_content', 'true');
    expect(await includeDemoContent(empty)).toBe(false);
    expect(await includeDemoContent(demo)).toBe(true);
    expect(await includeDemoContent(env.DB)).toBe(true);
  });
});
