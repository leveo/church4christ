import { describe, expect, it } from 'vitest';
import { enabledSitemapPaths, publicOrigin, renderRobots, renderSitemap, robotsDisallowPaths, siteVerificationTags, SITEMAP_PATHS } from '../src/lib/seo';
import { MODULE_KEYS } from '../src/lib/modules';
import { classifyRoute } from '../src/lib/routePolicy';

const request = new URL('https://worker.example.workers.dev/en/sermons?x=1');

describe('publicOrigin', () => {
  it('prefers a valid APP_ORIGIN and drops any path', () => {
    expect(publicOrigin('https://church.example.org/', request)).toBe('https://church.example.org');
    expect(publicOrigin('https://church.example.org/base/path', request)).toBe('https://church.example.org');
  });

  it('falls back to the request origin when APP_ORIGIN is missing or unusable', () => {
    expect(publicOrigin(undefined, request)).toBe('https://worker.example.workers.dev');
    expect(publicOrigin('', request)).toBe('https://worker.example.workers.dev');
    expect(publicOrigin('not a url', request)).toBe('https://worker.example.workers.dev');
    expect(publicOrigin('javascript:alert(1)', request)).toBe('https://worker.example.workers.dev');
  });
});

describe('siteVerificationTags', () => {
  it('emits only configured, well-formed tokens', () => {
    expect(siteVerificationTags({})).toEqual([]);
    expect(siteVerificationTags({ GOOGLE_SITE_VERIFICATION: ' abcDEF123_-xyz ', BING_SITE_VERIFICATION: 'ABCDEF0123456789' })).toEqual([
      { name: 'google-site-verification', content: 'abcDEF123_-xyz' },
      { name: 'msvalidate.01', content: 'ABCDEF0123456789' },
    ]);
  });

  it('ignores values that could inject markup', () => {
    expect(siteVerificationTags({ GOOGLE_SITE_VERIFICATION: '"><script>alert(1)</script>' })).toEqual([]);
    expect(siteVerificationTags({ BING_SITE_VERIFICATION: 'short' })).toEqual([]);
  });
});

describe('sitemap', () => {
  it('lists only public landing pages', () => {
    for (const path of SITEMAP_PATHS) expect(classifyRoute(path), path).toBe('public');
  });

  it('drops pages owned by disabled modules', () => {
    const all = enabledSitemapPaths(new Set(MODULE_KEYS));
    expect(all).toContain('/sermons');
    expect(all).toContain('/serve/gifts');
    const withoutSermons = enabledSitemapPaths(new Set(MODULE_KEYS.filter((key) => key !== 'sermons' && key !== 'gifts')));
    expect(withoutSermons).not.toContain('/sermons');
    expect(withoutSermons).not.toContain('/serve/gifts');
    expect(withoutSermons).toContain('/serve');
    expect(enabledSitemapPaths(new Set())).toEqual(expect.arrayContaining(['/', '/about', '/visit', '/give', '/privacy']));
    expect(enabledSitemapPaths(new Set())).not.toContain('/events');
  });

  it('renders both locales with hreflang alternates, escaped locations, and dates', () => {
    const xml = renderSitemap('https://church.example.org', [{ path: '/' }, { path: '/p/a&b', lastmod: '2026-11-01 08:30:00' }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<loc>https://church.example.org/en/</loc>');
    expect(xml).toContain('<loc>https://church.example.org/zh/</loc>');
    expect(xml).toContain('hreflang="zh-Hans" href="https://church.example.org/zh/"');
    expect(xml).toContain('hreflang="x-default" href="https://church.example.org/en/"');
    expect(xml).toContain('<loc>https://church.example.org/en/p/a&amp;b</loc>');
    expect(xml).toContain('<lastmod>2026-11-01</lastmod>');
    expect(xml.match(/<url>/gu)).toHaveLength(4);
  });

  it('omits a malformed lastmod instead of emitting an invalid date', () => {
    expect(renderSitemap('https://church.example.org', [{ path: '/about', lastmod: 'soon' }])).not.toContain('<lastmod>');
  });
});

describe('robots.txt', () => {
  it('allows the public site, blocks private areas, and names the sitemap', () => {
    const robots = renderRobots('https://church.example.org');
    expect(robots).toContain('User-agent: *\nAllow: /');
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Disallow: /en/my/');
    expect(robots).toContain('Disallow: /zh/my$');
    expect(robots).toContain('Sitemap: https://church.example.org/sitemap.xml');
  });

  it('never disallows a public landing page', () => {
    const disallowed = robotsDisallowPaths();
    for (const path of SITEMAP_PATHS) {
      for (const locale of ['en', 'zh']) {
        const url = path === '/' ? `/${locale}/` : `/${locale}${path}`;
        const blocked = disallowed.some((rule) => (rule.endsWith('$') ? url === rule.slice(0, -1) : url.startsWith(rule)));
        expect(blocked, url).toBe(false);
      }
    }
  });
});
