import { describe, expect, it } from 'vitest';
import { bilingualEmail } from '../src/lib/notify';
import blockouts from '../src/pages/[locale]/my/blockouts.astro?raw';
import calendar from '../src/pages/[locale]/my/calendar.astro?raw';
import monthCalendar from '../src/components/MonthCalendar.astro?raw';
import myIndex from '../src/pages/[locale]/my/index.astro?raw';
import serving from '../src/pages/[locale]/my/serving.astro?raw';
import respond from '../src/pages/respond/[token].astro?raw';
import notify from '../src/lib/notify.ts?raw';

describe('member pages on a phone', () => {
  it('stacks the blockout form, hides the repeat count until a repeat is chosen, and confirms deletes', () => {
    expect(blockouts).toContain('sm:grid-cols-2');
    expect(blockouts).toContain('blockout-count');
    expect(blockouts).toMatch(/@supports selector\(:has\(a\)\)/);
    expect(blockouts).toContain('formatDateWithWeekday(b.start_date');
    expect(blockouts).toContain('min-h-11');
    expect(blockouts).toContain('confirm(');
  });

  it('shows the agenda first on phones, dots-only grid, and richer subscribe options', () => {
    expect(calendar).toContain('order: -1');
    expect(calendar).toContain('https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}');
    expect(calendar).toContain('navigator.clipboard');
    expect(calendar).toContain('document.execCommand');
    expect(calendar).toContain('webcal://');
    expect(monthCalendar).toContain('max-width: 639px');
    expect(monthCalendar).not.toContain('font-size: .55rem');
  });

  it('confirms declines and uses touch-sized responsive controls for accept/decline/claim', () => {
    for (const page of [myIndex, serving]) {
      expect(page).toContain('data-confirm={t(locale, \'my.confirmDecline\')}');
      expect(page).toContain('col-span-2');
      expect(page).toContain('w-full sm:w-auto');
    }
    expect(myIndex).toMatch(/member-community-photo \{ display: none; \}/);
  });

  it('shows the weekday and time on the email response page and links onward after responding', () => {
    expect(respond).toContain('formatDateWithWeekday');
    expect(respond).toContain('start_time');
    expect(respond).toContain('data-confirm=');
    expect(respond).toContain('enterkeyhint="done"');
    expect(respond).toContain('/my/calendar');
  });

  it('renders the respond link in scheduling emails as a short button, not the raw token URL', () => {
    expect(notify).toContain("linkLabelKey: 'email.requestButton'");
    const url = 'https://church.example/respond/abc123token';
    const built = bilingualEmail({ subjectKey: 'email.requestSubject', bodyKey: 'email.requestBody', vars: { name: 'A', position: 'P', team: 'T', date: '2026-07-05', service: 'S' }, link: url, linkLabelKey: 'email.requestButton', only: 'en' });
    expect(built.html).toContain(`href="${url}"`);
    expect(built.html).toContain('Accept or decline</a>');
    expect(built.html).not.toContain(`>${url}<`);
    expect(built.text).toContain(url);
  });
});
