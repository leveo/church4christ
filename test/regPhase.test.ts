import { describe, expect, it } from 'vitest';
import { eventPhase } from '../src/lib/regPhase';

const base = {
  active: 1,
  visible_from: null as string | null,
  opens_at: null as string | null,
  closes_at: null as string | null,
  starts_at: '2030-06-10 18:00:00',
};
const at = (over: Partial<typeof base>, now: string) => eventPhase({ ...base, ...over }, now);

describe('eventPhase', () => {
  it('is open with no windows until the event starts, closed from the start time on', () => {
    expect(at({}, '2030-06-01 00:00:00')).toBe('open');
    expect(at({}, '2030-06-10 17:59:59')).toBe('open');
    expect(at({}, '2030-06-10 18:00:00')).toBe('closed'); // the boundary instant is closed
    expect(at({}, '2030-06-11 00:00:00')).toBe('closed');
  });

  it('closes at closes_at instead of the start time when one is set', () => {
    const over = { closes_at: '2030-06-05 12:00:00' };
    expect(at(over, '2030-06-05 11:59:59')).toBe('open');
    expect(at(over, '2030-06-05 12:00:00')).toBe('closed');
    expect(at({ closes_at: '2030-06-20 00:00:00' }, '2030-06-12 00:00:00')).toBe('open'); // after the start, before closes_at
  });

  it('is preview strictly before opens_at and open from the opening instant', () => {
    const over = { opens_at: '2030-06-02 09:00:00' };
    expect(at(over, '2030-06-02 08:59:59')).toBe('preview');
    expect(at(over, '2030-06-02 09:00:00')).toBe('open');
  });

  it('is hidden when inactive, whatever the windows say', () => {
    expect(at({ active: 0 }, '2030-06-01 00:00:00')).toBe('hidden');
    expect(at({ active: 0, opens_at: '2030-06-02 09:00:00' }, '2030-06-01 00:00:00')).toBe('hidden');
    expect(at({ active: 0 }, '2031-01-01 00:00:00')).toBe('hidden');
  });

  it('is hidden until visible_from, then follows the other windows', () => {
    const over = { visible_from: '2030-05-01 00:00:00', opens_at: '2030-05-15 00:00:00' };
    expect(at(over, '2030-04-30 23:59:59')).toBe('hidden');
    expect(at(over, '2030-05-01 00:00:00')).toBe('preview');
    expect(at(over, '2030-05-15 00:00:00')).toBe('open');
  });

  it('accepts a Date as the clock', () => {
    expect(eventPhase(base, new Date('2030-06-01T00:00:00Z'))).toBe('open');
    expect(eventPhase(base, new Date('2030-06-10T18:00:00Z'))).toBe('closed');
  });

  it('defaults to the current time', () => {
    expect(eventPhase({ ...base, starts_at: '2000-01-01 00:00:00' })).toBe('closed');
    expect(eventPhase({ ...base, starts_at: '2999-01-01 00:00:00' })).toBe('open');
  });
});
