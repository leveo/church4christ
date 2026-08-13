import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const people = readFileSync('docs/features/people-households.md', 'utf8');
const deploy = readFileSync('docs/deploy.md', 'utf8');
const upgrade = readFileSync('docs/upgrade.md', 'utf8');
const release = readFileSync('docs/release-process.md', 'utf8');
const changelog = readFileSync('CHANGELOG.md', 'utf8');

describe('create-only People mapping documentation', () => {
  it('documents the authoritative workflow, privacy boundary, and exact limits', () => {
    expect(people).toContain('/admin/people/import/map');
    expect(people).toMatch(/create-only/i);
    expect(people).toMatch(/does not (merge|update|revive)/i);
    expect(people).toMatch(/does not[^\n]*elevate/i);
    expect(people).toMatch(/current[^\n]*CSV/i);
    expect(people).toMatch(/exact[^\n]*header[^\n]*order/i);
    expect(people).toMatch(/profile[^\n]*(immutable|create-only)/i);
    expect(people).toMatch(/headers[\s\S]{0,160}mappings[\s\S]{0,100}constants[\s\S]{0,100}(translations|translation)/i);
    expect(people).toMatch(/does not store[^\n]*(upload|row|sample)/i);
    expect(people).toMatch(/256 KiB/i);
    expect(people).toMatch(/200 data rows/i);
    expect(people).toMatch(/128 source columns/i);
    expect(people).toMatch(/100 profiles/i);
    expect(people).toMatch(/320 KiB/i);
  });

  it('documents the D1 plan boundary and both provider migrations', () => {
    expect(deploy).toMatch(/mapping profiles[\s\S]{0,420}D1[\s\S]{0,100}(paid|Workers Paid)/i);
    expect(deploy).toMatch(/0012_people_import_mappings\.sql/i);
    expect(upgrade).toMatch(/0012_people_import_mappings\.sql/i);
    expect(upgrade).toMatch(/Files `0001` through `0016`/);
    expect(release).toMatch(/Files `0001` through\s+`0016`/);
    expect(changelog).toMatch(/Migration files `0001` through `0015`/);
    expect(changelog).toMatch(/create-only[^\n]*mapping/i);
    expect(changelog).toMatch(/people_import_mappings/i);
  });
});
