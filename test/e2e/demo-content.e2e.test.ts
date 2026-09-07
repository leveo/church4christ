import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deleteSetting, setSetting } from '../../src/lib/settings';
import { get } from './helpers';

const samples = [
  { directory: '/articles', slug: 'psalms-of-ascent' },
  { directory: '/about/staff', slug: 'david-chen' },
  { directory: '/fellowships', slug: 'campus' },
];

describe('bundled demo content on public routes', () => {
  it('keeps legacy samples and explicitly enabled demo samples available', async () => {
    try {
      for (const mode of [undefined, 'true']) {
        if (mode === undefined) await deleteSetting(env.DB, 'site.demo_content');
        else await setSetting(env.DB, 'site.demo_content', mode);
        for (const { directory, slug } of samples) {
          expect((await get(`/en${directory}/${slug}`)).status).toBe(200);
        }
      }
    } finally {
      await deleteSetting(env.DB, 'site.demo_content');
    }
  });

  it('keeps empty directory pages usable and hides sample links and direct URLs in both locales', async () => {
    await setSetting(env.DB, 'site.demo_content', 'false');
    try {
      for (const locale of ['en', 'zh']) {
        for (const { directory, slug } of samples) {
          const path = `/${locale}${directory}`;
          const response = await get(path);
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain('<main');
          expect(body).not.toContain(`${path}/${slug}`);
          expect((await get(`${path}/${slug}`)).status).toBe(404);
        }
      }
    } finally {
      await deleteSetting(env.DB, 'site.demo_content');
    }
  });

  it('uses published visit details instead of bundled fictional business facts', async () => {
    const fields = {
      'site.service_times.en': 'Saturday at 4 PM',
      'site.address': '42 Community Street',
      'site.email': 'welcome@church.example',
    };
    const originals = await env.DB.prepare(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?)',
    ).bind(...Object.keys(fields)).all<{ key: string; value: string }>();
    try {
      for (const [key, value] of Object.entries(fields)) await setSetting(env.DB, key, value);
      const response = await get('/en/visit');
      expect(response.status).toBe(200);
      const body = await response.text();
      for (const value of Object.values(fields)) expect(body).toContain(value);
      expect(body).not.toContain('123 Grace Avenue');
      expect(body).not.toContain('Our check-in table opens thirty minutes');
    } finally {
      for (const key of Object.keys(fields)) await deleteSetting(env.DB, key);
      for (const { key, value } of originals.results) await setSetting(env.DB, key, value);
    }
  });
});
