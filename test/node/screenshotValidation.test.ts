import { describe, expect, test } from 'vitest';
import {
  assertExpectedScreenshotPage,
  requireLocalScreenshotBase,
  requireScreenshotOnly,
  validateScreenshotManifest,
} from '../../scripts/lib/screenshot-validation.mjs';
import { LEARNING_DEMO_CAPTURE_ROWS, LEARNING_DEMO_SCREENSHOTS, RELEASE_SCREENSHOTS } from '../../scripts/screenshots.mjs';

const portalRow = { path: '/en/my', out: 'docs/images/portal/dashboard.png', expectedText: 'Chen Family' };

describe('screenshot page validation', () => {
  test('accepts the expected portal page', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      status: 200,
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Family Owner My groups Upcoming events',
    })).not.toThrow();
  });

  test('rejects a sign-in redirect', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/signin?next=%2Fen%2Fmy',
      status: 200,
      title: 'Sign in',
      headings: ['Sign in'],
      body: 'Email me a sign-in link',
    })).toThrow(/sign-in page/i);
  });

  test('accepts an intentional sign-in screenshot', () => {
    expect(() => assertExpectedScreenshotPage({
      path: '/en/signin',
      out: 'docs/images/public/signin.png',
    }, {
      url: 'http://localhost:4321/en/signin',
      status: 200,
      title: 'Sign in',
      headings: ['Sign in'],
      body: 'Email me a sign-in link',
    })).not.toThrow();
  });

  test('rejects an unexpected non-error pathname', () => {
    expect(() => assertExpectedScreenshotPage({
      path: '/en/my/household',
      out: 'docs/images/portal/household.png',
      expectedText: 'Chen Family',
    }, {
      url: 'http://localhost:4321/en/my',
      status: 200,
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Family Owner',
    })).toThrow(/unexpected path.*\/en\/my.*\/en\/my\/household/i);
  });

  test('rejects an unexpected query value', () => {
    expect(() => assertExpectedScreenshotPage({
      path: '/en/my/prayer?tab=pending',
      out: 'docs/images/portal/prayer-moderation.png',
      expectedText: 'Pending',
    }, {
      url: 'http://localhost:4321/en/my/prayer?tab=church',
      status: 200,
      title: 'Prayer moderation',
      headings: ['Pending'],
      body: 'Pending prayer requests',
    })).toThrow(/unexpected query.*tab.*church.*pending/i);
  });

  test('rejects a rendered 404', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      status: 404,
      title: 'Page not found',
      headings: ['Page not found'],
      body: 'The page you requested does not exist.',
    })).toThrow(/404/i);
  });

  test('rejects a Simplified Chinese not-found title', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      status: 200,
      title: '页面未找到',
      headings: [],
      body: 'Chen Family',
    })).toThrow(/404/i);
  });

  test('rejects a Traditional Chinese not-found title', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      status: 200,
      title: '頁面未找到',
      headings: [],
      body: 'Chen Family',
    })).toThrow(/404/i);
  });

  test('allows ordinary body text containing 404', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      status: 200,
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Family called extension 404 for assistance.',
    })).not.toThrow();
  });

  test('rejects a page missing its marker', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      status: 200,
      title: 'My Portal',
      headings: ['Welcome'],
      body: 'No seeded household here',
    })).toThrow(/Chen Family/);
  });
});

describe('v1 release screenshot manifest', () => {
  test('is explicit, unique, and covers every required built page', () => {
    expect(validateScreenshotManifest(RELEASE_SCREENSHOTS)).toBe(RELEASE_SCREENSHOTS);
    expect(RELEASE_SCREENSHOTS).toHaveLength(10);
  });

  test('rejects main-document errors and rejection markers', () => {
    const row = RELEASE_SCREENSHOTS[0];
    expect(() => assertExpectedScreenshotPage(row, { url: `http://localhost:4321${row.path}`, status: 500, title: '', headings: [], body: row.expectedText })).toThrow(/HTTP 500/);
    expect(() => assertExpectedScreenshotPage(row, { url: `http://localhost:4321${row.path}`, status: 200, title: row.expectedText, headings: [], body: 'Sign in' })).toThrow(/rejection marker/i);
  });
});

describe('Learning demo screenshot harness rows', () => {
  test('selects exact seeded English, Chinese, and admin identities without capturing files', () => {
    expect(validateScreenshotManifest(LEARNING_DEMO_SCREENSHOTS)).toBe(LEARNING_DEMO_SCREENSHOTS);
    expect(LEARNING_DEMO_SCREENSHOTS).toEqual([
      expect.objectContaining({
        path: '/en/learn/21000',
        out: 'docs/images/learning/genesis-1-en.png',
        identity: 'member',
        expectedText: 'Genesis 1: Creation / 创世记第一章：创造',
      }),
      expect.objectContaining({
        path: '/zh/learn/21000',
        out: 'docs/images/learning/genesis-1-zh.png',
        identity: 'member',
        expectedText: '创世记第一章：创造',
      }),
      expect.objectContaining({
        path: '/admin/learning',
        out: 'docs/images/learning/admin-overview.png',
        identity: 'admin',
        expectedText: 'Learning provider connections',
      }),
    ]);
    expect(LEARNING_DEMO_CAPTURE_ROWS).toEqual([
      expect.objectContaining({
        path: '/en/learn/21000',
        bypass: 'sarah.johnson@example.com',
        anchor: 'Course activities',
        sessionIdentity: { personId: 3, email: 'sarah.johnson@example.com', sessionEpoch: 0 },
        identityExpectedText: 'Not submitted',
        identityRejectionTexts: ['Returned', '已退回'],
      }),
      expect.objectContaining({
        path: '/zh/learn/21000',
        bypass: 'grace.lin@example.com',
        anchor: '课程活动',
        sessionIdentity: { personId: 4, email: 'grace.lin@example.com', sessionEpoch: 0 },
        identityExpectedText: '已退回',
        identityRejectionTexts: ['Not submitted', '未提交'],
      }),
      expect.objectContaining({
        path: '/admin/learning',
        admin: true,
        anchor: 'Course synchronization',
        anchorMargin: 600,
        sessionIdentity: { personId: 1, email: 'admin@example.com', sessionEpoch: 0 },
        identityExpectedText: 'admin@example.com',
        requiredTexts: [
          'Local fictional Canvas snapshot / 本地虚构 Canvas 快照',
          'https://canvas-learning.example.test',
        ],
      }),
    ]);
  });

  test('rejects a page rendered for the wrong seeded identity', () => {
    const row = {
      ...LEARNING_DEMO_CAPTURE_ROWS[0],
      identityExpectedText: 'Not submitted',
      identityRejectionTexts: ['Returned'],
    };
    expect(() => assertExpectedScreenshotPage(row, {
      url: 'http://localhost:4321/en/learn/21000',
      status: 200,
      title: row.expectedText,
      headings: [row.expectedText, 'Course activities'],
      body: 'Assignment Returned Quiz Submitted',
    })).toThrow(/identity rejection marker.*Returned/i);
  });
});

describe('screenshot capture selection', () => {
  test('rejects an unfiltered run before capture can start', () => {
    expect(() => requireScreenshotOnly(['node', 'scripts/screenshots.mjs']))
      .toThrow(/refusing unfiltered screenshot capture.*--only.*no files were written/i);
  });

  test('binds identity-bearing captures to an exact loopback origin', () => {
    expect(requireLocalScreenshotBase('http://localhost:4321')).toBe('http://localhost:4321');
    expect(requireLocalScreenshotBase('https://127.0.0.1:8443/')).toBe('https://127.0.0.1:8443');
    expect(requireLocalScreenshotBase('http://[::1]:4321')).toBe('http://[::1]:4321');

    for (const base of [
      'https://captures.example.test',
      'http://localhost.example.test:4321',
      'http://user:password@localhost:4321',
      'http://localhost:4321/dev',
      'http://localhost:4321/?target=remote',
      'file:///tmp/capture.html',
      'not-a-url',
    ]) {
      expect(() => requireLocalScreenshotBase(base)).toThrow(/loopback screenshot origin/i);
    }
  });
});
