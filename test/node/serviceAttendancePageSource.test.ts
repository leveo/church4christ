import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/pages/admin/attendance/index.astro', 'utf8');
const csv = readFileSync('src/lib/serviceAttendanceCsv.ts', 'utf8');
const enCopy = readFileSync('src/i18n/en.ts', 'utf8');
const attendanceCopy = enCopy.slice(
  enCopy.indexOf("'admin.attendance.title'"),
  enCopy.indexOf("'admin.role.member'"),
);

describe('service attendance page source boundaries', () => {
  it('guards module and area before the Admin layout and every database read', () => {
    const moduleGuard = page.indexOf("if (!modules.has('attendance'))");
    const areaGuard = page.indexOf("if (!hasAreaAccess(user, 'attendance'))");
    const methodGuard = page.indexOf("if (Astro.request.method !== 'GET')");
    const firstDbRead = Math.min(
      ...['await listServiceTypes(', 'await listServiceAttendanceReport(', 'await listCurrentServiceCheckinLinks(', 'await listEventsAdmin(']
        .map((needle) => page.indexOf(needle))
        .filter((index) => index >= 0),
    );
    const layout = page.indexOf('<Admin');
    expect(moduleGuard).toBeGreaterThan(-1);
    expect(areaGuard).toBeGreaterThan(moduleGuard);
    expect(methodGuard).toBeGreaterThan(areaGuard);
    expect(firstDbRead).toBeGreaterThan(methodGuard);
    expect(layout).toBeGreaterThan(firstDbRead);
  });

  it('never queries Children data when Children is off and uses one read-only link listing', () => {
    const childrenGate = page.indexOf("if (childrenEnabled && serviceTypes.length > 0)");
    const currentLinks = page.indexOf('listCurrentServiceCheckinLinks(Astro.locals.db)', childrenGate);
    const events = page.indexOf('listEventsAdmin(Astro.locals.db)', childrenGate);
    expect(childrenGate).toBeGreaterThan(-1);
    expect(currentLinks).toBeGreaterThan(childrenGate);
    expect(events).toBeGreaterThan(currentLinks);
    expect(page.match(/listCurrentServiceCheckinLinks\(/g)).toHaveLength(1);
    expect(page).not.toContain('getServiceCheckinLinkSnapshot');
    expect(page).not.toContain('replaceServiceCheckinLinksToday');
  });

  it('offers service-type editing only behind the Serve-area gate', () => {
    expect(page).toContain("const canManageServiceTypes = hasAreaAccess(user, 'serve')");
    expect(page).toMatch(/canManageServiceTypes\s*&&\s*<a[^>]+href="\/admin\/service-types"/);
    expect(page).toContain("t(lang, 'admin.attendance.emptyServicesAsk')");
  });

  it('contains no adult attendee identity fields in the page or CSV schema', () => {
    for (const source of [page, csv]) {
      expect(source).not.toMatch(/adult_(?:person|member|attendee|roster|identity|name|email)/i);
    }
    expect(csv).not.toMatch(/recorded_by|updated_by|person_email|member_id/i);
    expect(attendanceCopy).not.toMatch(/adult.{0,32}(?:attendee|identity|person|member|roster|name|email)/i);
  });
});
