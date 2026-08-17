import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const attendance = read('docs/features/service-attendance.md');
const children = read('docs/features/children-checkin.md');
const groups = read('docs/features/groups.md');
const modules = read('docs/features/modules.md');
const permissions = read('docs/features/admin-permissions.md');
const architecture = read('docs/architecture.md');
const deploy = read('docs/deploy.md');
const supabase = read('docs/supabase-setup.md');
const upgrade = read('docs/upgrade.md');
const release = read('docs/release-process.md');
const changelog = read('CHANGELOG.md');
const readme = read('README.md');

describe('aggregate service attendance documentation', () => {
  it('documents aggregate-only semantics and bounded reports without adult identities', () => {
    expect(attendance).toContain('/admin/attendance');
    expect(attendance).toMatch(/adult[^\n]*(aggregate|total)/i);
    expect(attendance).toMatch(/0[^\n]*100,?000/);
    expect(attendance).toMatch(/no adult[^\n]*(identity|name|roster|person)/i);
    expect(attendance).toMatch(/84 days/i);
    expect(attendance).toMatch(/366 days/i);
    expect(attendance).toMatch(/5,000 rows/i);
    expect(attendance).toMatch(/2 MiB/i);
    expect(attendance).toMatch(/first recorder[^\n]*(retained|preserved)/i);
  });

  it('documents derived child totals, date-effective links, and Children-off history', () => {
    expect(attendance).toMatch(/COUNT\(DISTINCT household_member_id\)/);
    expect(attendance).toMatch(/checked.out[^\n]*(still|count)/i);
    expect(attendance).toMatch(/inactive[^\n]*(still|history|count)/i);
    expect(attendance).toMatch(/not configured[^\n]*zero|zero[^\n]*not configured/i);
    expect(attendance).toMatch(/\[starts_on, ends_on\)/);
    expect(attendance).toMatch(/Children[^\n]*off[\s\S]{0,240}(history|reports?)[^\n]*(remain|stay|still)/i);
    expect(children).toMatch(/service attendance[\s\S]{0,260}(distinct|deduplicat)/i);
    expect(children).toMatch(/turning Children off[\s\S]{0,320}(history|reports?)[\s\S]{0,80}(remain|stay|still)/i);
  });

  it('documents the Attendance grant, service-type boundary, and separate Groups authority', () => {
    expect(attendance).toMatch(/Attendance[^\n]*grant/i);
    expect(attendance).toMatch(/module[\s\S]{0,100}off[\s\S]{0,100}404/i);
    expect(attendance).toMatch(/without[^\n]*grant[^\n]*403/i);
    expect(attendance).toMatch(/attendance-only[^\n]*cannot[^\n]*service types/i);
    expect(attendance).toMatch(/super.admin[\s\S]{0,100}Serve admin[\s\S]{0,100}service types/i);
    expect(permissions).toMatch(/16 grantable keys/i);
    expect(permissions).toMatch(/`attendance`/);
    expect(groups).toMatch(/Attendance[^\n]*grant[^\n]*(does not|never)[^\n]*(group|per.person)/i);
    expect(groups).toMatch(/Groups[^\n]*grant[\s\S]{0,180}(active group admin|group's active admin)[\s\S]{0,120}super.admin/i);
  });

  it('records migration 0013 on both providers and the current baseline counts', () => {
    expect(attendance).toMatch(/migrations\/0013_service_attendance\.sql/);
    expect(attendance).toMatch(/migrations-supabase\/0013_service_attendance\.sql/);
    expect(deploy).toMatch(/0013_service_attendance\.sql/);
    expect(upgrade).toMatch(/Migration `0013_service_attendance\.sql`/);
    expect(release).toMatch(/Files `0001` through\s+`0016`/);
    expect(changelog).toMatch(/Migration files `0001` through `0015`/);
    expect(changelog).toMatch(/aggregate service attendance/i);

    expect(readme).toMatch(/Service attendance[^\n]*docs\/features\/service-attendance\.md/i);
    expect(readme).toMatch(/Website \+ Community[^\n]*(?:\n[^\n]*)?18/);
    expect(readme).toMatch(/Full Church[^\n]*(?:\n[^\n]*)?21/);
    expect(modules).toMatch(/The 21 modules/);
    expect(modules).toMatch(/Website \+ Community[^\n]*(?:\n[^\n]*)?18/);
    expect(architecture).toMatch(/`attendance`[^\n]*Service Attendance/);
    expect(supabase).toMatch(/18 D1-compatible modules/i);

    for (const text of [readme, modules, deploy, supabase, read('docs/cloudflare-setup.md'), read('docs/why-this-stack.md')]) {
      expect(text).not.toMatch(/all 19 modules|19 module settings|all 16 D1-compatible modules|16 D1-compatible modules|other 16 modules/i);
    }
  });
});
