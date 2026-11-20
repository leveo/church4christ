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
  it('keeps Chinese-only block text out of English pages and preserves it in Chinese pages', async () => {
    const created = await savePageLayout(env.DB, {
      id: null, slug: 'e2e-built-locale-boundary', published: true,
      title_en: 'Locale Boundary', title_zh: '语言边界', updatedBy: 'e@x',
      layoutJson: JSON.stringify({ v: 1, blocks: [{
        id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'lg' },
        children: [
          { id: 'h1', type: 'heading', props: { level: 2, text: { en: '', zh: '仅中文标题' }, align: 'left', size: 'lg' } },
          { id: 't1', type: 'text', props: { md: { en: '', zh: '仅中文正文' }, align: 'left' } },
          { id: 'b1', type: 'button', props: { label: { en: '', zh: '仅中文按钮' }, href: '/zh/visit', variant: 'primary', align: 'left' } },
          { id: 't2', type: 'text', props: { md: { en: 'English fallback stays available.', zh: '' }, align: 'left' } },
        ],
      }] }),
    });
    expect(created.ok).toBe(true);

    const english = await get('/en/p/e2e-built-locale-boundary');
    expect(english.status).toBe(200);
    const englishHtml = await english.text();
    for (const text of ['仅中文标题', '仅中文正文', '仅中文按钮']) expect(englishHtml).not.toContain(text);
    expect(englishHtml).toContain('English fallback stays available.');
    expect(englishHtml).not.toContain('href="/zh/visit"');

    const chinese = await get('/zh/p/e2e-built-locale-boundary');
    expect(chinese.status).toBe(200);
    const chineseHtml = await chinese.text();
    for (const text of ['仅中文标题', '仅中文正文', '仅中文按钮', 'English fallback stays available.']) {
      expect(chineseHtml).toContain(text);
    }
  });

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

describe('registration block', () => {
  const ADMIN = () => sessionCookie(1, 'admin@example.com');
  const setModules = async (disabled: string[]) => {
    const body = new URLSearchParams({ action: 'modules' });
    for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
    expect((await post('/admin/settings', body.toString(), { cookie: await ADMIN() })).status).toBe(303);
  };
  const eventNode = (id: string, eventId: number | null, showSeats = true, label = { en: '', zh: '' }) =>
    ({ id, type: 'registration', props: { eventId, showSeats, buttonLabel: label } });
  const savePage = (slug: string, children: unknown[], cookie: string) =>
    jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug, published: true, title_en: slug, title_zh: '',
      layout: { v: 1, blocks: [{ id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md' }, children }] },
    }, cookie);

  it('saves through the builder POST and renders title, seats and the button; hides unknown, hidden and template events', async () => {
    await setModules([]);
    await env.DB.prepare(`UPDATE reg_events SET active = 1, capacity = 3, visible_from = NULL, opens_at = NULL, closes_at = datetime('now','+12 days'), starts_at = datetime('now','+14 days') WHERE id = 920`).run();
    const title = (await env.DB.prepare(`SELECT title FROM reg_event_i18n WHERE event_id = 920 AND locale = 'en'`).first<{ title: string }>())!.title;
    await env.DB.prepare(`INSERT INTO reg_events (id, starts_at, active, is_template) VALUES (8201, datetime('now','+20 days'), 1, 1)`).run();
    await env.DB.prepare(`INSERT INTO reg_events (id, starts_at, active) VALUES (8202, datetime('now','+20 days'), 0)`).run();
    for (const id of [8201, 8202]) await env.DB.prepare(`INSERT INTO reg_event_i18n (event_id, locale, title) VALUES (?1, 'en', ?2)`).bind(id, `Secret ${id}`).run();

    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const res = await savePage('e2e-reg-block', [
      eventNode('r1', 920, true, { en: 'Save my spot', zh: '' }),
      eventNode('r2', 8201), eventNode('r3', 8202), eventNode('r4', 999999), eventNode('r5', null),
    ], editor);
    expect(res.status).toBe(200);

    const html = await (await get('/en/p/e2e-reg-block')).text();
    expect(html).toContain(title);
    expect(html).toContain('Save my spot');
    expect(html).toContain('href="/en/register/920"');
    expect(html).toContain('Seats left: 3');
    expect(html).not.toContain('Secret 8201');
    expect(html).not.toContain('Secret 8202');
    expect(html.match(/registration-block /g)?.length).toBe(1);

    expect((await savePage('e2e-reg-block-seats', [eventNode('r1', 920, false)], editor)).status).toBe(200);
    const noSeats = await (await get('/en/p/e2e-reg-block-seats')).text();
    expect(noSeats).toContain('>Register</a>');
    expect(noSeats).not.toContain('Seats left');

    // Module off: the block renders nothing, the rest of the page is unaffected.
    await setModules(['registration']);
    const off = await (await get('/en/p/e2e-reg-block')).text();
    expect(off).not.toContain('registration-block ');
    expect(off).not.toContain('Save my spot');
    await setModules([]);
  });

  it('the builder page lists non-template events for the picker; events admin offers the link select only with the module on', async () => {
    await setModules([]);
    await env.DB.prepare(`INSERT OR IGNORE INTO reg_events (id, starts_at, active, is_template) VALUES (8203, datetime('now','+20 days'), 1, 1)`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO reg_event_i18n (event_id, locale, title) VALUES (8203, 'en', 'Template Only')`).run();
    const admin = await ADMIN();
    const builder = await (await get('/admin/pages/builder/new', { cookie: admin })).text();
    expect(builder).toMatch(/&quot;id&quot;:\[0,920\]/);
    expect(builder).not.toContain('Template Only');
    const events = await (await get('/admin/events', { cookie: admin })).text();
    expect(events).toMatch(/<select[^>]*data-reg-link/);
    expect(events).toContain('value="920"');
    expect(events).not.toContain('Template Only');

    await setModules(['registration']);
    const offEvents = await (await get('/admin/events', { cookie: admin })).text();
    expect(offEvents).not.toMatch(/<select[^>]*data-reg-link/);
    const offBuilder = await (await get('/admin/pages/builder/new', { cookie: admin })).text();
    expect(offBuilder).not.toMatch(/&quot;id&quot;:\[0,920\]/);
    await setModules([]);
  });
});
