import { describe, expect, it } from 'vitest';
import peoplePageSource from '../src/pages/admin/people/[id].astro?raw';

describe('Newcomers scoped grant management source boundaries', () => {
  it('keeps the flags mutation and form super-admin-only', () => {
    const postGuard = peoplePageSource.indexOf("if (!isSuper) return new Response(null, { status: 403 })");
    const flagWrite = peoplePageSource.indexOf('await setPersonFlags(', postGuard);
    const formGate = peoplePageSource.indexOf('{isSuper && (');
    const flagsForm = peoplePageSource.indexOf('name="action" value="flags"', formGate);
    expect(postGuard).toBeGreaterThan(-1);
    expect(flagWrite).toBeGreaterThan(postGuard);
    expect(formGate).toBeGreaterThan(-1);
    expect(flagsForm).toBeGreaterThan(formGate);
  });

  it('derives checkbox areas from the target role so non-admin targets expose only scoped grants', () => {
    expect(peoplePageSource).toContain('grantableAreasForRole(person.role)');
    expect(peoplePageSource).toContain('parseAdminAreasForRole(person.admin_areas, person.role)');
    expect(peoplePageSource).toContain('targetGrantableAreas.map((a) =>');
    expect(peoplePageSource).toMatch(/person\.role === 'admin'[\s\S]*?\)\}\s*<fieldset[\s\S]*?targetGrantableAreas\.map/);
  });

  it('renders Newcomers only as a grant checkbox and exposes no unregistered route entry', () => {
    expect(peoplePageSource).toContain("newcomers: 'admin.areas.newcomers'");
    expect(peoplePageSource).not.toContain('href="/admin/newcomers"');
  });
});
