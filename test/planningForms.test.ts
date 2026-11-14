import { describe, expect, it } from 'vitest';
import {
  parseAvailabilityForm,
  parseEventForm,
  parseFindTimeQuery,
  parseItemForm,
  parseSessionForm,
} from '../src/lib/planningForms';

const form = (entries: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  return fd;
};

describe('parseEventForm', () => {
  it('accepts a valid event and trims values', () => {
    const r = parseEventForm(form({ title_en: ' Christmas ', event_date: '2030-12-24', start_time: '10:00', end_time: '11:30', plan_id: '7' }));
    expect(r).toMatchObject({ ok: true, data: { title_en: 'Christmas', start_time: '10:00', end_time: '11:30', plan_id: 7 } });
  });

  it('needs a title in at least one language, a real date, and an end after the start', () => {
    const r = parseEventForm(form({ event_date: '2030-02-31', start_time: '10:00', end_time: '09:00' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['end_time', 'event_date', 'title_en']);
  });

  it('allows a Chinese-only title and no end time', () => {
    expect(parseEventForm(form({ title_zh: '圣诞', event_date: '2030-12-24', start_time: '10:00' })).ok).toBe(true);
  });
});

describe('parseItemForm', () => {
  it('validates duration and the fixed start', () => {
    expect(parseItemForm(form({ title_en: 'A', duration_min: '721' })).ok).toBe(false);
    expect(parseItemForm(form({ title_en: 'A', duration_min: '-1' })).ok).toBe(false);
    expect(parseItemForm(form({ title_en: 'A', duration_min: '5', fixed_start_time: '25:00' })).ok).toBe(false);
    const ok = parseItemForm(form({ title_zh: '诗歌', kind: 'song', duration_min: '5', owner_team_id: '2', owner_label: ' Guest ' }));
    expect(ok).toMatchObject({ ok: true, data: { kind: 'song', duration_min: 5, owner_team_id: 2, owner_label: 'Guest', fixed_start_time: null } });
  });

  it('falls back to a segment for an unknown kind', () => {
    const r = parseItemForm(form({ title_en: 'A', kind: 'weird' }));
    expect(r).toMatchObject({ ok: true, data: { kind: 'segment', duration_min: 0 } });
  });
});

describe('parseSessionForm', () => {
  it('requires start before end', () => {
    expect(parseSessionForm(form({ title_en: 'R', session_date: '2030-06-06', start_time: '19:00', end_time: '19:00' })).ok).toBe(false);
    expect(parseSessionForm(form({ title_en: 'R', session_date: '2030-06-06', start_time: '19:00', end_time: '20:00' })).ok).toBe(true);
  });
});

describe('parseAvailabilityForm', () => {
  it('collects weekdays and minutes', () => {
    const r = parseAvailabilityForm(form({ starts_on: '2030-06-01', ends_on: '2030-06-30', weekday: ['4', '1', 'x'], start_time: '18:00', end_time: '21:00' }));
    expect(r).toMatchObject({ ok: true, data: { weekdays: [1, 4], start_minute: 1080, end_minute: 1260 } });
  });

  it('defaults the end date to the start date and rejects bad windows or ranges', () => {
    expect(parseAvailabilityForm(form({ starts_on: '2030-06-01', start_time: '18:00', end_time: '21:00' }))).toMatchObject({ ok: true, data: { ends_on: '2030-06-01' } });
    expect(parseAvailabilityForm(form({ starts_on: '2030-06-01', start_time: '21:00', end_time: '18:00' })).ok).toBe(false);
    expect(parseAvailabilityForm(form({ starts_on: '2030-06-10', ends_on: '2030-06-01', start_time: '18:00', end_time: '21:00' })).ok).toBe(false);
    expect(parseAvailabilityForm(form({ starts_on: '2030-01-01', ends_on: '2032-01-01', start_time: '18:00', end_time: '21:00' })).ok).toBe(false);
  });
});

describe('parseFindTimeQuery', () => {
  it('applies defaults and rejects a range over 31 days', () => {
    expect(parseFindTimeQuery(new URLSearchParams('from=2030-06-01'))).toMatchObject({
      ok: true,
      data: { dateTo: '2030-06-01', durationMin: 90, earliestMin: 480, latestMin: 1260 },
    });
    expect(parseFindTimeQuery(new URLSearchParams('from=2030-06-01&to=2030-07-02')).ok).toBe(false);
    expect(parseFindTimeQuery(new URLSearchParams('from=2030-06-01&to=2030-07-01')).ok).toBe(true);
    expect(parseFindTimeQuery(new URLSearchParams('from=2030-06-01&duration=5')).ok).toBe(false);
  });
});
