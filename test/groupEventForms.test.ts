import { describe, it, expect } from 'vitest';
import { parseGroupEventForm, parseInlineMemberForm } from '../src/lib/groupEventForms';

const fdOf = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

const validEvent = {
  title: 'Bible Study',
  description: 'Weekly study',
  location: 'Room 101',
  recurrence: 'weekly',
  starts_on: '2026-07-15',
  start_time: '19:30',
  duration_min: '90',
  ends_on: '',
};

describe('parseGroupEventForm', () => {
  it('accepts a valid event and maps fields', () => {
    const r = parseGroupEventForm(fdOf({ ...validEvent, track_attendance: 'on' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      title: 'Bible Study',
      description: 'Weekly study',
      location: 'Room 101',
      recurrence: 'weekly',
      startsOn: '2026-07-15',
      startTime: '19:30',
      durationMin: 90,
      endsOn: null,
      trackAttendance: true,
    });
  });

  it('track_attendance absent → false; blank location → null', () => {
    const r = parseGroupEventForm(fdOf({ ...validEvent, location: '  ' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.trackAttendance).toBe(false);
    expect(r.data.location).toBeNull();
  });

  it('requires a title and rejects one over 200 chars', () => {
    expect((parseGroupEventForm(fdOf({ ...validEvent, title: '  ' })) as { ok: false; errors: Record<string, string> }).errors.title).toBe('errors.required');
    expect((parseGroupEventForm(fdOf({ ...validEvent, title: 'x'.repeat(201) })) as { ok: false; errors: Record<string, string> }).errors.title).toBe('errors.tooLong');
  });

  it('rejects a recurrence outside the enum', () => {
    const r = parseGroupEventForm(fdOf({ ...validEvent, recurrence: 'yearly' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.recurrence).toBe('errors.invalidOption');
  });

  it('rejects a malformed start date', () => {
    const r = parseGroupEventForm(fdOf({ ...validEvent, starts_on: '2026-13-40' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.starts_on).toBe('errors.dateFormat');
  });

  it('rejects a malformed / out-of-range time', () => {
    for (const bad of ['7:30', '19:60', '24:00', '1930', '']) {
      const r = parseGroupEventForm(fdOf({ ...validEvent, start_time: bad }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.errors.start_time).toBe('groups.manage.errTime');
    }
  });

  it('enforces the 15..720 duration window', () => {
    for (const bad of ['14', '721', '0', '-5', 'abc', '90.5']) {
      const r = parseGroupEventForm(fdOf({ ...validEvent, duration_min: bad }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.errors.duration_min).toBe('groups.manage.errDuration');
    }
    expect(parseGroupEventForm(fdOf({ ...validEvent, duration_min: '15' })).ok).toBe(true);
    expect(parseGroupEventForm(fdOf({ ...validEvent, duration_min: '720' })).ok).toBe(true);
  });

  it('accepts a valid ends_on and rejects one before starts_on', () => {
    const ok = parseGroupEventForm(fdOf({ ...validEvent, ends_on: '2026-12-31' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.endsOn).toBe('2026-12-31');

    const before = parseGroupEventForm(fdOf({ ...validEvent, ends_on: '2026-07-14' }));
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.errors.ends_on).toBe('groups.manage.errEndsBeforeStart');

    const bad = parseGroupEventForm(fdOf({ ...validEvent, ends_on: 'nope' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.ends_on).toBe('errors.dateFormat');
  });
});

describe('parseInlineMemberForm', () => {
  it('accepts first + last only (name-only member)', () => {
    const r = parseInlineMemberForm(fdOf({ first_name: 'Ada', last_name: 'Lovelace' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ firstName: 'Ada', lastName: 'Lovelace', email: null, phone: null });
  });

  it('lowercases a valid email and keeps phone', () => {
    const r = parseInlineMemberForm(fdOf({ first_name: 'Ada', last_name: 'L', email: 'ADA@Example.COM', phone: '555-1234' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.email).toBe('ada@example.com');
    expect(r.data.phone).toBe('555-1234');
  });

  it('requires first and last name', () => {
    const r = parseInlineMemberForm(fdOf({ first_name: '  ', last_name: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.first_name).toBe('errors.required');
    expect(r.errors.last_name).toBe('errors.required');
  });

  it('rejects names over 100 chars', () => {
    const r = parseInlineMemberForm(fdOf({ first_name: 'x'.repeat(101), last_name: 'L' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.first_name).toBe('errors.tooLong');
  });

  it('rejects an invalid email', () => {
    const r = parseInlineMemberForm(fdOf({ first_name: 'A', last_name: 'B', email: 'not-an-email' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.email).toBe('errors.emailInvalid');
  });

  it('rejects a phone over 40 chars', () => {
    const r = parseInlineMemberForm(fdOf({ first_name: 'A', last_name: 'B', phone: '1'.repeat(41) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.phone).toBe('errors.tooLong');
  });
});
