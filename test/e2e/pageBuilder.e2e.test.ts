// Page-builder e2e against the BUILT worker. This file covers the public
// zero-JS rendering path (builder-format pages render their layout tree as
// plain HTML with no island); test/e2e/customPages.e2e.test.ts still covers
// the markdown path. Admin/builder-route cases are appended by Task 7.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { savePageLayout } from '../../src/lib/pagesDb';
import { t } from '../../src/lib/i18n';
import { MODULE_KEYS } from '../../src/lib/modules';

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

function jsonPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

describe('builder admin route', () => {
  it('anon GET redirects to signin; editor GET mounts the island', async () => {
    const anon = await get('/admin/pages/builder/new');
    expect(anon.status).toBe(303);

    const editor = await get('/admin/pages/builder/new', { cookie: await sessionCookie(2, 'pastor.david@example.com') });
    expect(editor.status).toBe(200);
    const html = await editor.text();
    expect(html).toContain('astro-island'); // client:only mount point
  });

  it('module off → 404; back on → 200 (modules panel round-trip, admin session)', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    // Disable: write every module row except page-builder as '1' (full write,
    // like the panel does) — mirrors modules.e2e.test.ts's modulesBody helper.
    const off = new URLSearchParams({ action: 'modules' });
    for (const key of MODULE_KEYS) if (key !== 'page-builder') off.append(`module.${key}`, '1');
    await post('/admin/settings', off.toString(), { cookie: admin });

    const gated = await get('/admin/pages/builder/new', { cookie: admin });
    expect(gated.status).toBe(404);
    // Classic pages admin stays reachable (core, not module-owned).
    const classic = await get('/admin/pages', { cookie: admin });
    expect(classic.status).toBe(200);

    const on = new URLSearchParams({ action: 'modules' });
    for (const key of MODULE_KEYS) on.append(`module.${key}`, '1');
    await post('/admin/settings', on.toString(), { cookie: admin });
    const back = await get('/admin/pages/builder/new', { cookie: admin });
    expect(back.status).toBe(200);
  });

  it('JSON save creates a builder page that renders publicly; id echoes back', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const res = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'e2e-saved', published: true,
      title_en: 'Saved', title_zh: '', layout: {
        v: 1,
        blocks: [{ id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md' },
          children: [{ id: 'h1', type: 'heading', props: { level: 2, text: { en: 'From the island', zh: '' }, align: 'left', size: 'md' } }] }],
      },
    }, editor);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; id: string }>();
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();

    const pub = await get('/en/p/e2e-saved');
    expect(pub.status).toBe(200);
    expect(await pub.text()).toContain('From the island');
  });

  it('save echoes the normalized slug so "View on site" resolves', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const res = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'About-US', published: true,
      title_en: 'About Us E2E', title_zh: '', layout: { v: 1, blocks: [] },
    }, editor);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; slug: string }>();
    expect(body.ok).toBe(true);
    expect(body.slug).toBe('about-us');

    const pub = await get('/en/p/about-us');
    expect(pub.status).toBe(200);
  });

  it('rejects a hostile layout (400 invalid_layout) and a duplicate slug (409)', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const evil = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'e2e-evil', published: false, title_en: 'X', title_zh: '',
      layout: { v: 1, blocks: [{ id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md' },
        children: [{ id: 'b1', type: 'button', props: { label: { en: 'x', zh: '' }, href: 'javascript:alert(1)', variant: 'primary', align: 'left' } }] }] },
    }, editor);
    expect(evil.status).toBe(400);
    expect((await evil.json<{ error: string }>()).error).toBe('invalid_layout');

    const dup = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'e2e-saved', published: false, title_en: 'Dup', title_zh: '',
      layout: { v: 1, blocks: [] },
    }, editor);
    expect(dup.status).toBe(409);
    expect((await dup.json<{ error: string }>()).error).toBe('slug_taken');
  });

  it('upload rejects a non-image with the mapped i18n error key', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const fd = new FormData();
    fd.append('action', 'upload');
    fd.append('file', new File(['hello'], 'x.txt', { type: 'text/plain' }));
    const res = await SELF.fetch(`${ORIGIN}/admin/pages/builder/new`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: editor }, body: fd, redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('errors.imageType');
  });
});

describe('classic pages admin integrates the builder', () => {
  it('shows the New page (builder) button and per-row Design links to editors', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    await savePageLayout(env.DB, {
      id: null, slug: 'e2e-list-builder', published: false,
      title_en: 'Listed', title_zh: '', layoutJson: JSON.stringify({ v: 1, blocks: [] }), updatedBy: 'e@x',
    });
    const res = await get('/admin/pages', { cookie: editor });
    const html = await res.text();
    expect(html).toContain('/admin/pages/builder/new');   // the new-page button
    // pastor.david's seeded lang is 'zh' — the admin console renders per user.lang.
    expect(html).toContain(t('zh', 'admin.pages.formatBuilder')); // badge on the builder row
    expect(html).toMatch(/\/admin\/pages\/builder\/[0-9a-f-]{36}/); // per-row Design link
  });

  it('classic edit form for a builder page hides body textareas, links to the builder, and does not wipe the layout on save', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const created = await savePageLayout(env.DB, {
      id: null, slug: 'e2e-classic-edit', published: false,
      title_en: 'CE', title_zh: '', layoutJson: JSON.stringify({ v: 1, blocks: [] }), updatedBy: 'e@x',
    });
    if (!created.ok) throw new Error('seed failed');

    const form = await get(`/admin/pages?edit=${created.id}`, { cookie: editor });
    const html = await form.text();
    // pastor.david's seeded lang is 'zh' — the admin console renders per user.lang.
    expect(html).toContain(t('zh', 'admin.pages.builderNote'));
    expect(html).not.toContain('name="body_en"');

    // Classic save (slug/title/publish) must leave format/layout intact.
    const body = new URLSearchParams({ action: 'save', id: created.id, slug: 'e2e-classic-edit', title_en: 'CE2', title_zh: '', body_en: '', body_zh: '' });
    await post('/admin/pages', body.toString(), { cookie: editor });
    const row = await env.DB.prepare(`SELECT format, layout_json FROM custom_pages WHERE id = ?1`).bind(created.id).first<{ format: string; layout_json: string }>();
    expect(row!.format).toBe('builder');
    expect(row!.layout_json).toBe(JSON.stringify({ v: 1, blocks: [] }));
  });
});
