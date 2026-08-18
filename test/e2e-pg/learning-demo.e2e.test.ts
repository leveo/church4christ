import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('canonical Genesis Learning demo on the built PostgreSQL worker', () => {
  it('loads the portable seed and preserves exact learner authorization in both locales', async () => {
    const english = await get('/en/learn/21000', {
      cookie: await sessionCookie(3, 'sarah.johnson@example.com'),
    });
    expect(english.status).toBe(200);
    const englishHtml = await english.text();
    expect(englishHtml).toContain('Genesis 1: Creation / 创世记第一章：创造');
    expect(englishHtml).toContain('data-embed="https://www.youtube-nocookie.com/embed/DemoGen1Vid"');
    expect(englishHtml).not.toContain('<iframe');
    expect(englishHtml).toContain('Submitted');
    expect(englishHtml).toContain('Not submitted');

    const chinese = await get('/zh/learn/21000', {
      cookie: await sessionCookie(4, 'grace.lin@example.com'),
    });
    expect(chinese.status).toBe(200);
    const chineseHtml = await chinese.text();
    expect(chineseHtml).toContain('课程活动');
    expect(chineseHtml).toContain('已退回');
    expect(chineseHtml).toContain('已提交');

    const denied = await get('/en/learn/21000', {
      cookie: await sessionCookie(5, 'mark.liu@example.com'),
    });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('Genesis');
  });
});
