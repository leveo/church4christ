import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pagePath = 'src/pages/admin/activity-score/index.astro';

describe('activity score admin source boundaries', () => {
  it('guards capability, area, and methods before reading or rendering', () => {
    const page = readFileSync(pagePath, 'utf8');
    const moduleGuard = page.indexOf("if (!modules.has('activity-score'))");
    const areaGuard = page.indexOf("if (!hasAreaAccess(user, 'activity-score'))");
    const methodGuard = page.indexOf("if (method !== 'GET' && method !== 'POST')");
    const firstRead = page.indexOf('await buildActivityScoreReport(');
    const layout = page.indexOf('<Admin');
    expect(moduleGuard).toBeGreaterThan(-1);
    expect(areaGuard).toBeGreaterThan(moduleGuard);
    expect(methodGuard).toBeGreaterThan(areaGuard);
    expect(firstRead).toBeGreaterThan(methodGuard);
    expect(layout).toBeGreaterThan(firstRead);
  });

  it('limits configuration writes to super admins and rejects unavailable selected sources', () => {
    const page = readFileSync(pagePath, 'utf8');
    const post = page.indexOf("if (method === 'POST')");
    const superGuard = page.indexOf('if (!user!.isSuperAdmin)', post);
    const sourceGuard = page.indexOf('selectedSourcesAvailable', superGuard);
    const save = page.indexOf('await saveActivityScoreConfig(', sourceGuard);
    expect(post).toBeGreaterThan(-1);
    expect(superGuard).toBeGreaterThan(post);
    expect(sourceGuard).toBeGreaterThan(superGuard);
    expect(save).toBeGreaterThan(sourceGuard);
  });

  it('bounds visible rows, fails closed, and renders explainable evidence', () => {
    const page = readFileSync(pagePath, 'utf8');
    expect(page).toContain('filterActivityScores(report.rows, filters).slice(0, 100)');
    expect(page).toContain('report = null');
    expect(page).toContain('<details');
    expect(page).toContain('dimension.numerator');
    expect(page).toContain('dimension.denominator');
    expect(page).toContain('dimension.weight');
  });

  it('does not introduce sensitive activity sources or person fields', () => {
    const page = readFileSync(pagePath, 'utf8');
    expect(page).not.toMatch(/giving|prayer|pastoral_notes|service_attendance/i);
    expect(page).not.toMatch(/person\.email|row\.email|group_name|position_name|event_name/i);
  });

  it('registers the page in admin navigation and the dashboard', () => {
    const layout = readFileSync('src/layouts/Admin.astro', 'utf8');
    const dashboard = readFileSync('src/pages/admin/index.astro', 'utf8');
    expect(layout).toContain("href: '/admin/activity-score'");
    expect(layout).toContain("module: 'activity-score', area: 'activity-score'");
    expect(dashboard).toContain("modules.has('activity-score')");
    expect(dashboard).toContain('href="/admin/activity-score"');
  });
});
