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
    expect(peoplePageSource).toContain('parseAdminAreasForRole(person.admin_areas, person.role)');
    expect(peoplePageSource).toContain('GRANTABLE_AREAS.map((a) =>');
    expect(peoplePageSource).toContain('grantCheckboxStateForRole(person.role, a, personAreas.includes(a))');
    expect(peoplePageSource).toContain('data-grant-area={a}');
    expect(peoplePageSource).toContain('data-role-disabled={initialState.roleDisabled ? \'true\' : \'false\'}');
  });

  it('safely synchronizes grant controls whenever the selected final role changes', () => {
    expect(peoplePageSource).toContain("document.querySelector('[data-person-role]') as unknown as HTMLSelectElement | null");
    expect(peoplePageSource).toContain("document.querySelectorAll<HTMLInputElement>('[data-grant-area]')");
    expect(peoplePageSource).toContain("roleSelect.addEventListener('change', syncGrantControls)");
    expect(peoplePageSource).toContain('grantCheckboxStateForRole(role, area, checkbox.checked)');
    expect(peoplePageSource).toContain('checkbox.checked = state.checked');
    expect(peoplePageSource).toContain('checkbox.disabled = state.roleDisabled || checkbox.dataset.backendDisabled === \'true\'');
    expect(peoplePageSource).toContain('label.hidden = state.hidden');
    expect(peoplePageSource).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|set:html/);
  });

  it('renders Newcomers only as a grant checkbox and exposes no unregistered route entry', () => {
    expect(peoplePageSource).toContain("newcomers: 'admin.areas.newcomers'");
    expect(peoplePageSource).not.toContain('href="/admin/newcomers"');
  });
});
