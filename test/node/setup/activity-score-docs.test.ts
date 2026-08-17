import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const feature = read('docs/features/activity-score.md');
const permissions = read('docs/features/admin-permissions.md');
const modules = read('docs/features/modules.md');
const readme = read('README.md');
const upgrade = read('docs/upgrade.md');
const release = read('docs/release-process.md');
const changelog = read('CHANGELOG.md');

describe('activity score documentation', () => {
  it('documents the explainable model, supported dimensions, limits, and exclusions', () => {
    expect(feature).toContain('/admin/activity-score');
    expect(feature).toMatch(/30, 60, 90, or 180 days/i);
    expect(feature).toMatch(/group attendance/i);
    expect(feature).toMatch(/confirmed serving/i);
    expect(feature).toMatch(/registration engagement/i);
    expect(feature).toMatch(/5,000 eligible people/i);
    expect(feature).toMatch(/100\s+filtered\s+rows/i);
    expect(feature).toMatch(/giving[\s\S]{0,160}excluded/i);
    expect(feature).toMatch(/membership status[^\n]*(filter|eligib)/i);
  });

  it('documents source-off behavior and the dedicated admin grant', () => {
    expect(feature).toMatch(/source[^\n]*disabled[\s\S]{0,220}renormal/i);
    expect(feature).toMatch(/super admin[\s\S]{0,100}(edit|configuration)/i);
    expect(feature).toMatch(/Activity Score[^\n]*grant/i);
    expect(permissions).toMatch(/activity.score/i);
    expect(permissions).toMatch(/16 grantable keys/i);
  });

  it('records migration 0016 and the expanded capability counts', () => {
    expect(feature).toMatch(/migrations\/0016_activity_score\.sql/);
    expect(feature).toMatch(/migrations-supabase\/0016_activity_score\.sql/);
    expect(upgrade).toContain('0016_activity_score.sql');
    expect(release).toMatch(/Files .*0001.* through\s+.*0016/);
    expect(changelog).toContain('0016_activity_score.sql');
    expect(readme).toMatch(/Activity score[^\n]*docs\/features\/activity-score\.md/i);
    expect(modules).toMatch(/The 21 modules/);
    expect(modules).toMatch(/Website \+ Community[^\n]*(?:\n[^\n]*)?18/);
    expect(readme).toMatch(/Full Church[^\n]*(?:\n[^\n]*)?21/);
  });
});
