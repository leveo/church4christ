import { describe, expect, it } from 'vitest';
import { qrSvg } from '../src/lib/qr';
import children from '../src/pages/admin/children/index.astro?raw';
import kioskIndex from '../src/pages/kiosk/[token]/index.astro?raw';
import kioskHousehold from '../src/pages/kiosk/[token]/household/[id].astro?raw';
import chart from '../src/components/admin/children/WeeklyCheckinChart.astro?raw';

describe('children check-in on a phone', () => {
  it('renders each Today check-in as a card on phones and keeps the table from 640px', () => {
    expect(children).toContain('data-roster-cards');
    expect(children).toContain('sm:hidden');
    expect(children).toContain('hidden sm:block');
    expect(children).toMatch(/btnSecondary\} w-full/);
  });

  it('draws the kiosk QR server-side as inline SVG with no external service', () => {
    expect(children).toContain('qrSvg(');
    expect(children).not.toMatch(/api\.qrserver|chart\.googleapis|qr-code-generator/);
    const svg = qrSvg('https://example.org/kiosk/abc123', 'QR');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox=');
    expect(svg).toContain('aria-label="QR"');
    expect(svg).not.toContain('http://api');
    expect(qrSvg('', 'QR')).toBe('');
    expect(qrSvg('https://a.test/<x>', 'a"b<')).toContain('aria-label="a&quot;b&lt;"');
  });

  it('configures kiosk inputs for touch keyboards', () => {
    expect(kioskIndex).toContain('type="search"');
    expect(kioskIndex).toContain('enterkeyhint="search"');
    expect(kioskIndex).toContain('spellcheck="false"');
    expect(kioskHousehold).toContain('enterkeyhint="go"');
    expect(kioskHousehold).toContain('autocapitalize="characters"');
    expect(kioskHousehold).toContain('pattern=');
    expect(kioskHousehold).toContain('min-h-11');
  });

  it('scales the weekly chart through its viewBox instead of a fixed minimum width', () => {
    expect(chart).not.toContain('min-w-[720px]');
    expect(chart).toContain('w-full');
  });
});
