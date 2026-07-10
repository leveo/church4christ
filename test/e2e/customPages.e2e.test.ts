// Public custom-page route (/[locale]/p/[slug]) against the BUILT worker:
// a published page renders through ContentPage with its title + rendered
// markdown body; an unpublished page 404s for anon but previews (with a draft
// banner) for an editor/admin session; an unknown slug always 404s; a zh
// request against a page with an empty zh title/body falls back independently
// to the en content. Pages are seeded through saveCustomPage (the Task 2 data
// layer, src/lib/pagesDb.ts), not raw SQL — mirrors test/pagesDb.test.ts.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { saveCustomPage } from '../../src/lib/pagesDb';
import { t } from '../../src/lib/i18n';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

/** A `cookie:` header carrying a freshly minted session JWT for a seeded person. */
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('public custom-page route (/[locale]/p/[slug])', () => {
  it('a published page renders 200 with its title and rendered markdown body', async () => {
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'e2e-published',
      published: true,
      title_en: 'Published Page E2E',
      title_zh: '已发布页面 E2E',
      body_en: 'Hello **world**.',
      body_zh: '你好 **世界**。',
      updatedBy: 'pastor.david@example.com',
    });

    const res = await get('/en/p/e2e-published');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Published Page E2E');
    expect(html).toContain('Hello <strong>world</strong>.');
    // No draft banner on a published page.
    expect(html).not.toContain(t('en', 'pages.draftNotice'));
  });

  it('an unpublished page 404s for an anonymous visitor', async () => {
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'e2e-draft',
      published: false,
      title_en: 'Draft Page E2E',
      title_zh: '草稿页面 E2E',
      body_en: 'Draft body.',
      body_zh: '草稿内容。',
      updatedBy: 'pastor.david@example.com',
    });

    const res = await get('/en/p/e2e-draft');
    expect(res.status).toBe(404);
  });

  it('an unpublished page previews (200, with a draft notice) for an editor session', async () => {
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'e2e-draft-preview',
      published: false,
      title_en: 'Draft Preview Page E2E',
      title_zh: '草稿预览页面 E2E',
      body_en: 'Draft preview body.',
      body_zh: '草稿预览内容。',
      updatedBy: 'pastor.david@example.com',
    });

    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const res = await get('/en/p/e2e-draft-preview', { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Draft Preview Page E2E');
    expect(html).toContain('Draft preview body.');
    expect(html).toContain(t('en', 'pages.draftNotice'));
  });

  it('an unknown slug 404s for both anonymous and admin sessions', async () => {
    expect((await get('/en/p/no-such-slug')).status).toBe(404);
    const cookie = await sessionCookie(1, 'admin@example.com');
    expect((await get('/en/p/no-such-slug', { cookie })).status).toBe(404);
  });

  it('zh locale with empty zh title/body falls back independently to en content', async () => {
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'e2e-fallback',
      published: true,
      title_en: 'Fallback Title EN',
      title_zh: '',
      body_en: 'Fallback body EN.',
      body_zh: '',
      updatedBy: 'pastor.david@example.com',
    });

    const res = await get('/zh/p/e2e-fallback');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Fallback Title EN');
    expect(html).toContain('Fallback body EN.');
  });
});
