// Event logistics, pure parts: the room range parser and the auto-seat planner (no database).
import { describe, expect, it } from 'vitest';
import { parseRoomLabels, MAX_ROOMS_PER_CALL, defaultCapacityRule } from '../src/lib/regHousing';
import { planSeating, type PlanParty, type PlanTable, type SeatingInput } from '../src/lib/regSeatPlanner';

describe('parseRoomLabels', () => {
  it('expands numeric and prefixed ranges and keeps plain labels', () => {
    expect(parseRoomLabels('101-104, A1-A3, Loft')).toEqual({ ok: true, labels: ['101', '102', '103', '104', 'A1', 'A2', 'A3', 'Loft'] });
  });

  it('keeps the zero-padding of the start and accepts a range without the second prefix', () => {
    expect(parseRoomLabels('008-011')).toEqual({ ok: true, labels: ['008', '009', '010', '011'] });
    expect(parseRoomLabels('B01-03')).toEqual({ ok: true, labels: ['B01', 'B02', 'B03'] });
    expect(parseRoomLabels('Room 9 - 10')).toEqual({ ok: true, labels: ['Room 9', 'Room 10'] });
    expect(parseRoomLabels('7–8')).toEqual({ ok: true, labels: ['7', '8'] }); // en dash
  });

  it('splits on commas, semicolons, new lines and full-width punctuation, and drops duplicates', () => {
    expect(parseRoomLabels('1-2;3\n4，5、2, ,')).toEqual({ ok: true, labels: ['1', '2', '3', '4', '5'] });
    expect(parseRoomLabels('North-Wing, Cabin A')).toEqual({ ok: true, labels: ['North-Wing', 'Cabin A'] });
    expect(parseRoomLabels('5-5')).toEqual({ ok: true, labels: ['5'] });
  });

  it('refuses reversed, mismatched, huge, empty and overlong input', () => {
    expect(parseRoomLabels('120-101')).toEqual({ ok: false, code: 'reversed', segment: '120-101' });
    expect(parseRoomLabels('A1-B3')).toEqual({ ok: false, code: 'bad_range', segment: 'A1-B3' });
    expect(parseRoomLabels('1-100000')).toMatchObject({ ok: false, code: 'too_many' });
    expect(parseRoomLabels(`1-${MAX_ROOMS_PER_CALL}`)).toMatchObject({ ok: true });
    expect(parseRoomLabels(`1-${MAX_ROOMS_PER_CALL}, X`)).toEqual({ ok: false, code: 'too_many' });
    expect(parseRoomLabels(' , ;\n')).toEqual({ ok: false, code: 'empty' });
    expect(parseRoomLabels('x'.repeat(41))).toMatchObject({ ok: false, code: 'too_long' });
    expect(parseRoomLabels('a\u0007b')).toMatchObject({ ok: false, code: 'too_long' });
  });

  it('defaults the capacity rule from the venue kind', () => {
    expect(['hotel', 'dorm', 'campsite', 'other'].map((k) => defaultCapacityRule(k as never))).toEqual(['soft', 'hard', 'hard', 'soft']);
  });
});

const table = (id: number, seats: number, hostAttendeeId: number | null = null): PlanTable => ({ id, seats, hostAttendeeId });
let nextId = 1000;
const party = (registrationId: number, size: number, opts: { tags?: number[][]; tableId?: Array<number | null> } = {}): PlanParty => ({
  registrationId,
  people: Array.from({ length: size }, (_, i) => ({ attendeeId: ++nextId, tags: opts.tags?.[i] ?? [], tableId: opts.tableId?.[i] ?? null })),
});
const tableOf = (plan: ReturnType<typeof planSeating>, attendeeId: number) => plan.seats.find((s) => s.attendeeId === attendeeId)?.tableId ?? null;
const tablesOfParty = (plan: ReturnType<typeof planSeating>, p: PlanParty) => new Set(p.people.map((x) => tableOf(plan, x.attendeeId)));

describe('planSeating', () => {
  it('keeps parties together and fills tables evenly', () => {
    const parties = [party(1, 3), party(2, 2), party(3, 2), party(4, 1)];
    const plan = planSeating({ tables: [table(1, 4), table(2, 4)], parties, rules: {} });
    for (const p of parties) expect(tablesOfParty(plan, p).size).toBe(1);
    const counts = [1, 2].map((t) => plan.seats.filter((s) => s.tableId === t).length);
    expect(counts).toEqual([4, 4]);
    expect(plan.violations).toEqual({ partySplit: 0, noRoom: 0, spread: 0, hostMissing: 0 });
    expect(plan.changes).toHaveLength(8);
  });

  it('is deterministic for the same input', () => {
    const input: SeatingInput = { tables: [table(1, 5), table(2, 5), table(3, 5)], parties: [party(1, 2), party(2, 3), party(3, 1), party(4, 4)], rules: {} };
    expect(planSeating(input)).toEqual(planSeating(structuredClone(input)));
  });

  it('splits only a party larger than every table, and leaves a party that does not fit unseated', () => {
    const big = party(1, 5);
    const plan = planSeating({ tables: [table(1, 3), table(2, 3)], parties: [big], rules: {} });
    expect(tablesOfParty(plan, big).size).toBe(2);
    expect(plan.violations.partySplit).toBe(1);

    // Three parties of three, two tables of four: the last party in order (registration 4) stays out whole.
    const three = [party(2, 3), party(3, 3), party(4, 3)];
    const tight = planSeating({ tables: [table(1, 4), table(2, 4)], parties: three, rules: {} });
    expect(tight.left).toEqual(three[2].people.map((p) => p.attendeeId));
    expect(tight.violations).toMatchObject({ noRoom: 3, partySplit: 0 });
  });

  it('keeps existing seats and brings a partly seated party to its table; start over reseats everyone', () => {
    const seated = party(1, 3, { tableId: [2, null, null] });
    const other = party(2, 1, { tableId: [1] });
    const plan = planSeating({ tables: [table(1, 4), table(2, 4)], parties: [seated, other], rules: {} });
    expect(tablesOfParty(plan, seated)).toEqual(new Set([2]));
    expect(tableOf(plan, other.people[0].attendeeId)).toBe(1);
    expect(plan.changes.map((c) => c.attendeeId)).toEqual([seated.people[1].attendeeId, seated.people[2].attendeeId]);

    const again = planSeating({ tables: [table(1, 4), table(2, 4)], parties: [seated, other], rules: { startOver: true } });
    expect(tablesOfParty(again, seated).size).toBe(1);
    expect(again.seats).toHaveLength(4);
  });

  it('spreads a tag and reports what it could not spread', () => {
    const X = 7;
    const parties = [party(1, 1, { tags: [[X]] }), party(2, 1, { tags: [[X]] }), party(3, 1, { tags: [[X]] }), party(4, 1), party(5, 1)];
    const plan = planSeating({ tables: [table(1, 3), table(2, 3), table(3, 3)], parties, rules: { spread: [{ tagId: X, max: 1 }] } });
    const xTables = parties.slice(0, 3).map((p) => tableOf(plan, p.people[0].attendeeId));
    expect(new Set(xTables).size).toBe(3);
    expect(plan.violations.spread).toBe(0);

    const crowded = planSeating({ tables: [table(1, 3)], parties: parties.slice(0, 3), rules: { spread: [{ tagId: X, max: 1 }] } });
    expect(crowded.violations.spread).toBe(2);
  });

  it('gives tables with a tagged guest a host-tagged person and makes them the host', () => {
    const NEW = 1;
    const HOST = 2;
    const hostA = party(1, 1, { tags: [[HOST]] });
    const hostB = party(2, 1, { tags: [[HOST]] });
    const guests = [party(3, 2, { tags: [[NEW], [NEW]] }), party(4, 1, { tags: [[NEW]] })];
    const plan = planSeating({ tables: [table(1, 4), table(2, 4), table(3, 4)], parties: [...guests, hostA, hostB], rules: { host: { forTagId: NEW, hostTagId: HOST } } });
    expect(plan.violations.hostMissing).toBe(0);
    const hosted = new Set([tableOf(plan, hostA.people[0].attendeeId), tableOf(plan, hostB.people[0].attendeeId)]);
    expect(hosted.size).toBe(2);
    for (const g of guests) expect(hosted.has(tableOf(plan, g.people[0].attendeeId))).toBe(true);
    expect(plan.hosts.map((h) => h.attendeeId).sort()).toEqual([hostA.people[0].attendeeId, hostB.people[0].attendeeId].sort());

    const none = planSeating({ tables: [table(1, 4), table(2, 4)], parties: [party(5, 4, { tags: [[NEW]] }), party(6, 4, { tags: [[NEW]] })], rules: { host: { forTagId: NEW, hostTagId: HOST } } });
    expect(none.violations.hostMissing).toBe(2);
  });

  it('clears a host who no longer sits at the table after starting over', () => {
    const p = party(1, 1, { tableId: [1] });
    const plan = planSeating({ tables: [table(1, 1, p.people[0].attendeeId), table(2, 2)], parties: [party(2, 2), p], rules: { startOver: true } });
    if (tableOf(plan, p.people[0].attendeeId) !== 1) expect(plan.hosts).toContainEqual({ tableId: 1, attendeeId: null });
    else expect(plan.hosts).toEqual([]);
  });
});
