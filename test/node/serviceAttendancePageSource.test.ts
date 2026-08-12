import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/pages/admin/attendance/index.astro', 'utf8');
const csv = readFileSync('src/lib/serviceAttendanceCsv.ts', 'utf8');
const enCopy = readFileSync('src/i18n/en.ts', 'utf8');
const attendanceCopy = enCopy.slice(
  enCopy.indexOf("'admin.attendance.title'"),
  enCopy.indexOf("'admin.role.member'"),
);
const countRoute = readFileSync('src/pages/admin/attendance/count.ts', 'utf8');
const linkRoute = readFileSync('src/pages/admin/attendance/checkin-links.ts', 'utf8');

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

  it('renders link mutation forms only after both independent link-editor reads succeed', () => {
    const currentLinksRead = page.indexOf('await listCurrentServiceCheckinLinks(Astro.locals.db)');
    const eventsRead = page.indexOf('await listEventsAdmin(Astro.locals.db)', currentLinksRead);
    const readyAssignment = page.indexOf('linkEditorReady = true', eventsRead);
    const linkReadCatch = page.indexOf('} catch {', currentLinksRead);
    const linkSection = page.indexOf("t(lang, 'admin.attendance.linksTitle')");
    const errorBranch = page.indexOf('linkEditorError ?', linkSection);
    const readyBranch = page.indexOf('linkEditorReady ?', errorBranch);
    const linkForm = page.indexOf('<form method="post" action="/admin/attendance/checkin-links"', readyBranch);

    expect(currentLinksRead).toBeGreaterThan(-1);
    expect(eventsRead).toBeGreaterThan(currentLinksRead);
    expect(readyAssignment).toBeGreaterThan(eventsRead);
    expect(linkReadCatch).toBeGreaterThan(readyAssignment);
    expect(page.slice(linkReadCatch, linkSection)).toContain('linkEditorError = true');
    expect(page.slice(linkReadCatch, linkSection)).not.toContain('windowError = true');
    expect(errorBranch).toBeGreaterThan(linkSection);
    expect(readyBranch).toBeGreaterThan(errorBranch);
    expect(linkForm).toBeGreaterThan(readyBranch);
    expect(page.slice(errorBranch, readyBranch)).toContain("t(lang, 'admin.attendance.linksLoadError')");
  });

  it('offers service-type editing only behind the Serve-area gate', () => {
    expect(page).toContain("const canManageServiceTypes = modules.has('serve') && hasAreaAccess(user, 'serve')");
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

  it('gates both mutations before the shared bounded reader and never calls formData directly', () => {
    for (const source of [countRoute, linkRoute]) {
      const moduleGuard = source.indexOf("if (!locals.modules.has('attendance'))");
      const areaGuard = source.indexOf("if (!hasAreaAccess(user, 'attendance'))");
      const reader = source.indexOf('await readServiceAttendanceForm(request)');
      expect(moduleGuard).toBeGreaterThan(-1);
      expect(areaGuard).toBeGreaterThan(moduleGuard);
      expect(reader).toBeGreaterThan(areaGuard);
      expect(source).not.toContain('.formData()');
    }
    const childrenGuard = linkRoute.indexOf("if (!locals.modules.has('children'))");
    expect(childrenGuard).toBeGreaterThan(linkRoute.indexOf("if (!hasAreaAccess(user, 'attendance'))"));
    expect(linkRoute.indexOf('await readServiceAttendanceForm(request)')).toBeGreaterThan(childrenGuard);
  });
});
