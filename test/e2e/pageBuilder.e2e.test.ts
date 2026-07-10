// Page-builder e2e against the BUILT worker. This file covers the public
// zero-JS rendering path (builder-format pages render their layout tree as
// plain HTML with no island); test/e2e/customPages.e2e.test.ts still covers
// the markdown path. Admin/builder-route cases are appended by Task 7.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { savePageLayout } from '../../src/lib/pagesDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

const LAYOUT = JSON.stringify({
  v: 1,
  blocks: [
    {
      id: 's1', type: 'section',
      props: { bg: 'primary', width: 'content', padY: 'lg' },
      children: [
        { id: 'h1', type: 'heading', props: { level: 1, text: { en: 'Welcome Home', zh: '欢迎回家' }, align: 'center', size: 'xl' } },
        { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [
          [{ id: 't1', type: 'text', props: { md: { en: 'We are **glad** you came.', zh: '' }, align: 'left' } }],
          [{ id: 'b1', type: 'button', props: { label: { en: 'Plan a visit', zh: '计划来访' }, href: '/en/visit', variant: 'primary', align: 'center' } }],
        ] },
      ],
    },
  ],
});

describe('builder pages render zero-JS on the public route', () => {
  it('a published builder page renders sections, columns, markdown text, and button — with NO island', async () => {
    await savePageLayout(env.DB, {
      id: null, slug: 'e2e-built', published: true,
      title_en: 'Built Page', title_zh: '构建页', layoutJson: LAYOUT, updatedBy: 'e@x',
    });
    const res = await get('/en/p/e2e-built');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Welcome Home');                       // heading text (en)
    expect(html).toContain('bg-primary-soft');                    // section bg class
    expect(html).toContain('container-content');                  // section width class
    expect(html).toContain('sm:grid-cols-2');                     // columns class
    expect(html).toContain('We are <strong>glad</strong> you came.'); // markdown-rendered text
    expect(html).toContain('Plan a visit');                       // button label
    expect(html).not.toContain('astro-island');                   // zero client JS
  });

  it('zh locale picks zh text and falls back per-field to en', async () => {
    const res = await get('/zh/p/e2e-built');
    const html = await res.text();
    expect(html).toContain('欢迎回家');                              // zh heading
    expect(html).toContain('We are <strong>glad</strong> you came.'); // text falls back to en (zh empty)
  });

  it('a corrupt stored layout renders empty for anon and shows a notice to an editor', async () => {
    const created = await savePageLayout(env.DB, {
      id: null, slug: 'e2e-corrupt', published: true,
      title_en: 'Corrupt', title_zh: '', layoutJson: JSON.stringify({ v: 1, blocks: [] }), updatedBy: 'e@x',
    });
    if (!created.ok) throw new Error('seed failed');
    await env.DB.prepare(`UPDATE custom_pages SET layout_json = '{"v":9}' WHERE id = ?1`).bind(created.id).run();

    const anon = await get('/en/p/e2e-corrupt');
    expect(anon.status).toBe(200);
    expect(await anon.text()).not.toContain('invalid layout data');

    const editor = await get('/en/p/e2e-corrupt', { cookie: await sessionCookie(2, 'pastor.david@example.com') });
    expect(await editor.text()).toContain('invalid layout data');
  });
});
