import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PEOPLE_IMPORT_HEADERS } from '../../../src/lib/peopleImport';

const people = readFileSync('docs/features/people-households.md', 'utf8');
const upgrade = readFileSync('docs/upgrade.md', 'utf8');
const release = readFileSync('docs/release-process.md', 'utf8');
const changelog = readFileSync('CHANGELOG.md', 'utf8');

describe('portable People export documentation', () => {
  it('documents the canonical create-only round trip and every structural boundary', () => {
    expect(people).toContain('/admin/people/export');
    expect(people).toContain(PEOPLE_IMPORT_HEADERS.join(','));
    expect(people).toMatch(/200 data rows/i);
    expect(people).toMatch(/100 households/i);
    expect(people).toMatch(/256 KiB/i);
    expect(people).toMatch(/25 parts/i);
    expect(people).toMatch(/5,000 data rows/i);
    expect(people).toMatch(/6\.25 MiB/i);
    expect(people).toMatch(/never split/i);
    expect(people).toMatch(/repair.required/i);
    expect(people).toMatch(/create-only/i);
    expect(people).toMatch(/clean target/i);
    expect(people).toMatch(/D1[^\n]*snapshot/i);
    expect(people).toMatch(/PostgreSQL[^\n]*snapshot/i);
    for (const excluded of ['pastoral notes', 'roles', 'admin permissions', 'security', 'internal IDs']) {
      expect(people.toLowerCase()).toContain(excluded.toLowerCase());
    }
  });

  it('documents the super-admin-only audited pastoral-notes contract without implying a join key', () => {
    expect(people).toContain('/admin/people/export-notes');
    expect(people).toContain('person_ref,person_email,author_attribution,body,created_at');
    expect(people).toContain('EXPORT PASTORAL NOTES');
    expect(people).toMatch(/super.admin only/i);
    expect(people).toMatch(/5,000 notes/i);
    expect(people).toMatch(/10 MiB/i);
    expect(people).toMatch(/actor[\s\S]{0,80}time[\s\S]{0,80}numeric counts/i);
    expect(people).toMatch(/no[^\n]*(email|note body|body)[^\n]*(audit|event)|audit[^\n]*no[^\n]*(email|note body|body)/i);
    expect(people).toMatch(/person_ref[\s\S]{0,120}(file.local|local)[\s\S]{0,120}(not|never)[\s\S]{0,80}(join key|foreign key)/i);
  });

  it('records migration 0011 as the forward and frozen export boundary', () => {
    expect(people).toMatch(/migration[^\n]*0011_people_exports\.sql/i);
    expect(upgrade).toMatch(/Files `0001` through `0011`/);
    expect(release).toMatch(/Files `0001` through\s+`0011`/);
    expect(changelog).toMatch(/Migration files `0001` through `0011`/);
    expect(changelog).toMatch(/canonical People\/Household export/i);
    expect(changelog).toMatch(/pastoral.notes export/i);
    expect(changelog).toMatch(/audit_events/);
  });
});
