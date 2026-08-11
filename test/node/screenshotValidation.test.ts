import { describe, expect, test } from 'vitest';
import { assertExpectedScreenshotPage } from '../../scripts/lib/screenshot-validation.mjs';

const portalRow = { path: '/en/my', out: 'docs/images/portal/dashboard.png', expectedText: 'Chen Household' };

describe('screenshot page validation', () => {
  test('accepts the expected portal page', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Household Owner My groups Upcoming events',
    })).not.toThrow();
  });

  test('rejects a sign-in redirect', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/signin?next=%2Fen%2Fmy',
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
      title: 'Sign in',
      headings: ['Sign in'],
      body: 'Email me a sign-in link',
    })).not.toThrow();
  });

  test('rejects an unexpected non-error pathname', () => {
    expect(() => assertExpectedScreenshotPage({
      path: '/en/my/household',
      out: 'docs/images/portal/household.png',
      expectedText: 'Chen Household',
    }, {
      url: 'http://localhost:4321/en/my',
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Household Owner',
    })).toThrow(/unexpected path.*\/en\/my.*\/en\/my\/household/i);
  });

  test('rejects an unexpected query value', () => {
    expect(() => assertExpectedScreenshotPage({
      path: '/en/my/prayer?tab=pending',
      out: 'docs/images/portal/prayer-moderation.png',
      expectedText: 'Pending',
    }, {
      url: 'http://localhost:4321/en/my/prayer?tab=church',
      title: 'Prayer moderation',
      headings: ['Pending'],
      body: 'Pending prayer requests',
    })).toThrow(/unexpected query.*tab.*church.*pending/i);
  });

  test('rejects a rendered 404', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'Page not found',
      headings: ['Page not found'],
      body: 'The page you requested does not exist.',
    })).toThrow(/404/i);
  });

  test('rejects a Simplified Chinese not-found title', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: '页面未找到',
      headings: [],
      body: 'Chen Household',
    })).toThrow(/404/i);
  });

  test('rejects a Traditional Chinese not-found title', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: '頁面未找到',
      headings: [],
      body: 'Chen Household',
    })).toThrow(/404/i);
  });

  test('allows ordinary body text containing 404', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Household called extension 404 for assistance.',
    })).not.toThrow();
  });

  test('rejects a page missing its marker', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'My Portal',
      headings: ['Welcome'],
      body: 'No seeded household here',
    })).toThrow(/Chen Household/);
  });
});
