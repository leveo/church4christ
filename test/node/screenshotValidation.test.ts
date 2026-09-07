import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import * as screenshots from '../../scripts/screenshots.mjs';
import {
  assertExpectedScreenshotPage,
  requireLocalScreenshotBase,
  requireScreenshotOnly,
  validateScreenshotManifest,
} from '../../scripts/lib/screenshot-validation.mjs';
import { LEARNING_DEMO_CAPTURE_ROWS, LEARNING_DEMO_SCREENSHOTS, RELEASE_SCREENSHOTS } from '../../scripts/screenshots.mjs';

const portalRow = { path: '/en/my', out: 'docs/images/portal/dashboard.png', expectedText: 'Chen Family' };

describe('README capture inventory', () => {
  test('requires the visibly uppercase Worship team in the seeded scheduling matrix', () => {
    const row = screenshots.README_CAPTURE_ROWS.find((row) => row.out === 'docs/images/serve/matrix.png')!;
    const page = {
      url: 'http://localhost:4321/en/serve/matrix/1', status: 200,
      title: 'Scheduling Matrix · Sunday Worship (English)',
      headings: ['Sunday Worship (English)'],
      body: 'Sunday Worship (English) WORSHIP TEAM Leader Vocalist',
    };
    expect(() => assertExpectedScreenshotPage(row, page)).not.toThrow();
    expect(() => assertExpectedScreenshotPage(row, { ...page, body: 'Sunday Worship (English) Leader Vocalist' }))
      .toThrow(/required capture marker.*WORSHIP TEAM/);
  });

  test('selects exactly the complete README preset without unrelated feature screenshots', () => {
    expect(screenshots.selectScreenshotRows(['node', 'scripts/screenshots.mjs', '--only', 'readme'])).toEqual(screenshots.README_CAPTURE_ROWS);
    expect(screenshots.selectScreenshotRows(['node', 'scripts/screenshots.mjs', '--only', 'identity/merge-review-queue.jpg'])).toEqual([
      expect.objectContaining({ path: '/admin/people/identity/merge', sessionIdentity: { personId: 1, email: 'admin@example.com', sessionEpoch: 0 } }),
    ]);
    expect(() => screenshots.selectScreenshotRows(['node', 'scripts/screenshots.mjs', '--only', ''])).toThrow(/matched no pages/);
  });
  test('covers every README image exactly once as a real page or a separately maintained diagram', () => {
    const images = [...new Set(readFileSync(new URL('../../README.md', import.meta.url), 'utf8').match(/docs\/images\/[^)\s]+/g))].sort();
    const outputs = [...(screenshots.README_CAPTURE_ROWS ?? []).map((row) => row.out), ...(screenshots.README_DIAGRAMS ?? [])];
    expect(outputs.sort()).toEqual(images);
    expect(screenshots.README_CAPTURE_ROWS).toHaveLength(29);
    expect(screenshots.README_DIAGRAMS).toHaveLength(4);
  });

  test('requires page markers and dedicated seeded identities for every authenticated README image', () => {
    expect(screenshots.README_SCREENSHOTS).toBeDefined();
    expect(validateScreenshotManifest(screenshots.README_SCREENSHOTS)).toBe(screenshots.README_SCREENSHOTS);
    for (const row of screenshots.README_CAPTURE_ROWS) {
      expect(screenshots.CAPTURE_ROWS.filter((candidate) => candidate.out === row.out)).toEqual([row]);
      if (row.identity === 'public') expect(row.sessionIdentity).toBeUndefined();
      else expect(row.sessionIdentity).toEqual(expect.objectContaining({ personId: expect.any(Number), sessionEpoch: 0 }));
      expect(() => assertExpectedScreenshotPage(row, { url: 'http://localhost:4321/en/signin', status: 200, title: 'Sign in', body: row.expectedText })).toThrow(/sign-in page/);
    }
  });

  test('frames a required panel only when the anchor is actually present', () => {
    const row = { out: 'docs/images/admin/settings-modules.png', anchor: 'Modules', anchorMargin: 40 };
    expect(screenshots.screenshotClip(row, 350)).toEqual({ x: 0, y: 310, width: 1280, height: 800, scale: 1 });
    expect(() => screenshots.screenshotClip(row, -1)).toThrow(/anchor.*Modules/);
    expect(() => screenshots.screenshotClip(row, undefined)).toThrow(/anchor.*Modules/);
  });

  test('writes JPEG bytes to JPEG outputs and validates their real dimensions', () => {
    expect(screenshots.screenshotFormat('docs/images/identity/merge-review-queue.jpg')).toBe('jpeg');
    expect(screenshots.screenshotFormat('docs/images/public/home-en.png')).toBe('png');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 3, 32, 5, 0, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(screenshots.screenshotImageDimensions(jpeg, 'jpeg')).toEqual({ width: 1280, height: 800 });
    expect(() => screenshots.screenshotImageDimensions(jpeg, 'png')).toThrow(/PNG/);
    expect(() => screenshots.screenshotImageDimensions(Buffer.from('not an image'), 'jpeg')).toThrow(/JPEG/);
  });

  test('isolates each browser target so admin cookies cannot leak into public or other member shots', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let contexts = 0;
    const cdp = { send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Target.createBrowserContext') return { browserContextId: `context-${++contexts}` };
      if (method === 'Target.createTarget') return { targetId: `target-${contexts}` };
      return { sessionId: `session-${contexts}` };
    } };
    const first = await screenshots.createScreenshotTarget(cdp);
    await first.close();
    const second = await screenshots.createScreenshotTarget(cdp);
    await second.close();
    expect(calls.filter(({ method }) => method === 'Target.createTarget').map(({ params }) => params.browserContextId)).toEqual(['context-1', 'context-2']);
    expect(calls.filter(({ method }) => method === 'Target.disposeBrowserContext').map(({ params }) => params.browserContextId)).toEqual(['context-1', 'context-2']);
  });
});

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
        expectedText: 'Genesis 1: Creation',
      }),
      expect.objectContaining({
        path: '/zh/learn/21000',
        out: 'docs/images/learning/genesis-1-zh.png',
        identity: 'member',
        expectedText: 'Genesis 1: Creation',
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
        anchor: 'Learning provider connections',
        sessionIdentity: { personId: 1, email: 'admin@example.com', sessionEpoch: 0 },
        identityExpectedText: 'admin@example.com',
        requiredTexts: [
          'Local fictional Canvas snapshot',
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
