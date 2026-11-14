import { describe, expect, it } from 'vitest';
import matrix from '../src/pages/[locale]/serve/matrix/[serviceTypeId].astro?raw';
import availability from '../src/components/admin/AvailabilityTab.astro?raw';
import ministriesTab from '../src/components/admin/MinistriesTab.astro?raw';
import consolePage from '../src/pages/admin/ministries/index.astro?raw';
import emailTab from '../src/components/admin/EmailTab.astro?raw';
import plan from '../src/pages/[locale]/serve/plans/[id].astro?raw';
import team from '../src/pages/[locale]/serve/teams/[id].astro?raw';
import opportunities from '../src/pages/[locale]/serve/opportunities.astro?raw';

describe('volunteer scheduling on a phone', () => {
  it('shows a per-date stacked matrix below md and keeps the table from md up', () => {
    expect(matrix).toContain('data-matrix-stacked');
    expect(matrix).toMatch(/class="grid gap-4 md:hidden"/);
    expect(matrix).toContain('mw-matrix hidden md:block');
    expect(matrix).toContain('formatDateWithWeekday');
    expect(matrix).toContain('weekdayOf(p.plan_date)');
    expect(matrix).toContain('min-h-11');
  });

  it('shows availability as member cards on phones with a sticky first header cell', () => {
    expect(availability).toContain('data-availability-cards');
    expect(availability).toContain('sticky left-0 z-[2]');
    expect(availability).toContain('hidden overflow-x-auto');
  });

  it('keeps ministry edit forms out of the table and uses cards on phones', () => {
    expect(ministriesTab).toContain('data-ministry-cards');
    expect(ministriesTab).toContain('data-ministry-edit-list');
    expect(ministriesTab).not.toContain('colspan');
  });

  it('scrolls console tabs horizontally on phones and enlarges email toggles and chips', () => {
    expect(consolePage).toContain('overflow-x-auto whitespace-nowrap');
    expect(consolePage).toContain('shrink-0');
    expect(emailTab).toContain('h-11 w-14');
    expect(emailTab).toContain('min-h-11');
  });

  it('wraps plan and team forms and uses numeric inputs', () => {
    expect(plan).toContain('type="number"');
    expect(plan).toContain('inputmode="numeric"');
    expect(plan).toContain('flex-wrap');
    expect(team).toContain('flex flex-wrap items-center gap-2');
    expect(team).toContain('min-h-11');
  });

  it('shows opportunity dates with a weekday', () => {
    expect(opportunities).toContain('formatDateWithWeekday(d.plan_date');
  });
});
