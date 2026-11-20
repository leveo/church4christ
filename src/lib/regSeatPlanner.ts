// The auto-seat planner: a pure, deterministic function from the tables, the parties and the staff's rules to a
// complete seating. The event page previews it; applySeatingPlan (regSeating.ts) re-runs it on the server from
// the same data (a version stamp proves the data did not change) and writes the result in one guarded batch.
//
// Rules, in order of importance:
//   1. keep each party (one registration) at one table; a party is split only when it is larger than every table
//      (counted as `partySplit`), and a party that does not fit anywhere right now stays unseated (`noRoom`);
//   2. a party already partly seated (when existing seats are kept) joins its own table when it fits;
//   3. "spread tag X: at most N per table" (each excess person at a table counts once in `spread`);
//   4. "a table with someone tagged Y gets a host tagged Z": host-tagged parties are spread across the tables
//      first, Y-tagged parties prefer tables that already have one (each Y table without one counts in
//      `hostMissing`), and every table with a host-tagged person and no host gets the first of them as host;
//   5. fill tables evenly (lowest share of seats used after placing), then the table order.
// Parties are placed largest first (host-tagged parties before everyone else), ties by registration id, so the
// same input always gives the same plan.

export interface PlanTable {
  id: number;
  seats: number;
  hostAttendeeId: number | null;
}

export interface PlanPerson {
  attendeeId: number;
  tags: number[];
  /** The table the person sits at now (null = unseated). */
  tableId: number | null;
}

export interface PlanParty {
  registrationId: number;
  /** The party's people who may be seated, in party order. */
  people: PlanPerson[];
}

export interface SeatingRules {
  /** Clear every seat first (default: keep existing seats and seat only the unseated). */
  startOver?: boolean;
  spread?: Array<{ tagId: number; max: number }>;
  host?: { forTagId: number; hostTagId: number } | null;
}

export interface SeatingInput {
  /** In board order (the tie-break of last resort). */
  tables: PlanTable[];
  parties: PlanParty[];
  rules: SeatingRules;
}

export interface SeatingViolations {
  partySplit: number;
  noRoom: number;
  spread: number;
  hostMissing: number;
}

export interface SeatingPlan {
  /** Everyone seated after the plan, in table order then placement order. */
  seats: Array<{ attendeeId: number; tableId: number }>;
  /** The seats that differ from now (new or moved), what an apply writes. */
  changes: Array<{ attendeeId: number; tableId: number }>;
  /** People seated now whom the plan unseats (only when starting over and they no longer fit). */
  unseated: number[];
  /** People the plan could not seat. */
  left: number[];
  /** Tables whose host changes (null = the host is cleared because they no longer sit there). */
  hosts: Array<{ tableId: number; attendeeId: number | null }>;
  violations: SeatingViolations;
}

export const MAX_SPREAD_RULES = 10;

interface Unit {
  registrationId: number;
  people: PlanPerson[];
  anchor: number | null;
  hasHost: boolean;
}

export function planSeating(input: SeatingInput): SeatingPlan {
  const rules = input.rules;
  const startOver = rules.startOver === true;
  const spread = (rules.spread ?? []).filter((r) => Number.isSafeInteger(r.tagId) && Number.isSafeInteger(r.max) && r.max >= 0);
  const host = rules.host ?? null;
  const tables = input.tables;
  const index = new Map(tables.map((t, i) => [t.id, i]));
  const occ = new Map<number, PlanPerson[]>(tables.map((t) => [t.id, []]));
  const hasTag = (p: PlanPerson, tag: number) => p.tags.includes(tag);
  const count = (people: PlanPerson[], tag: number) => people.reduce((n, p) => n + (hasTag(p, tag) ? 1 : 0), 0);

  const units: Unit[] = [];
  for (const party of input.parties) {
    const keep: PlanPerson[] = [];
    const place: PlanPerson[] = [];
    for (const p of party.people) {
      if (!startOver && p.tableId !== null && index.has(p.tableId)) keep.push(p);
      else place.push(p);
    }
    for (const p of keep) occ.get(p.tableId!)!.push(p);
    if (place.length === 0) continue;
    let anchor: number | null = null;
    if (keep.length > 0) {
      const byTable = new Map<number, number>();
      for (const p of keep) byTable.set(p.tableId!, (byTable.get(p.tableId!) ?? 0) + 1);
      anchor = [...byTable.entries()].sort((a, b) => b[1] - a[1] || index.get(a[0])! - index.get(b[0])!)[0][0];
    }
    units.push({ registrationId: party.registrationId, people: place, anchor, hasHost: host !== null && place.some((p) => hasTag(p, host.hostTagId)) });
  }
  units.sort((a, b) => Number(b.hasHost) - Number(a.hasHost) || b.people.length - a.people.length || a.registrationId - b.registrationId);

  const free = (t: PlanTable) => t.seats - occ.get(t.id)!.length;
  const largest = tables.reduce((m, t) => Math.max(m, t.seats), 0);
  const violations: SeatingViolations = { partySplit: 0, noRoom: 0, spread: 0, hostMissing: 0 };
  const left: number[] = [];

  for (const unit of units) {
    const size = unit.people.length;
    const fits = tables.filter((t) => free(t) >= size);
    if (fits.length > 0) {
      const score = (t: PlanTable): number[] => {
        const here = occ.get(t.id)!;
        const spreadPenalty = spread.reduce((n, r) => n + Math.max(0, count(here, r.tagId) + count(unit.people, r.tagId) - r.max), 0);
        const hostCount = unit.hasHost && host ? count(here, host.hostTagId) : 0;
        const needsHost = host !== null && !unit.hasHost && unit.people.some((p) => hasTag(p, host.forTagId)) && count(here, host.hostTagId) === 0 ? 1 : 0;
        return [unit.anchor !== null && t.id !== unit.anchor ? 1 : 0, spreadPenalty, hostCount, needsHost, (here.length + size) / t.seats, index.get(t.id)!];
      };
      const best = fits
        .map((t) => ({ t, s: score(t) }))
        .sort((a, b) => {
          for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return a.s[i] - b.s[i];
          return 0;
        })[0].t;
      if (unit.anchor !== null && best.id !== unit.anchor) violations.partySplit++;
      occ.get(best.id)!.push(...unit.people);
      continue;
    }
    if (size > largest) {
      // Larger than every table: the one case a party is split, filling the emptiest tables first.
      let placed = 0;
      for (const person of unit.people) {
        const target = [...tables].filter((t) => free(t) > 0).sort((a, b) => free(b) - free(a) || index.get(a.id)! - index.get(b.id)!)[0];
        if (!target) {
          left.push(person.attendeeId);
          violations.noRoom++;
          continue;
        }
        occ.get(target.id)!.push(person);
        placed++;
      }
      if (placed > 0) violations.partySplit++;
      continue;
    }
    for (const person of unit.people) left.push(person.attendeeId);
    violations.noRoom += size;
  }

  for (const t of tables) {
    const here = occ.get(t.id)!;
    for (const r of spread) violations.spread += Math.max(0, count(here, r.tagId) - r.max);
    if (host && count(here, host.forTagId) > 0 && count(here, host.hostTagId) === 0) violations.hostMissing++;
  }

  const seats: SeatingPlan['seats'] = [];
  const now = new Map<number, number | null>();
  for (const party of input.parties) for (const p of party.people) now.set(p.attendeeId, p.tableId !== null && index.has(p.tableId) ? p.tableId : null);
  for (const t of tables) for (const p of occ.get(t.id)!) seats.push({ attendeeId: p.attendeeId, tableId: t.id });
  const planned = new Map(seats.map((s) => [s.attendeeId, s.tableId]));
  const changes = seats.filter((s) => now.get(s.attendeeId) !== s.tableId);
  const unseated = [...now.entries()].filter(([id, table]) => table !== null && !planned.has(id)).map(([id]) => id).sort((a, b) => a - b);

  const hosts: SeatingPlan['hosts'] = [];
  for (const t of tables) {
    const here = occ.get(t.id)!;
    const hostSits = t.hostAttendeeId !== null && here.some((p) => p.attendeeId === t.hostAttendeeId);
    if (t.hostAttendeeId !== null && !hostSits) hosts.push({ tableId: t.id, attendeeId: null });
    if (host && (t.hostAttendeeId === null || !hostSits)) {
      const pick = here.find((p) => hasTag(p, host.hostTagId));
      if (pick) {
        const prior = hosts.findIndex((h) => h.tableId === t.id);
        if (prior >= 0) hosts.splice(prior, 1);
        hosts.push({ tableId: t.id, attendeeId: pick.attendeeId });
      }
    }
  }

  return { seats, changes, unseated, left, hosts, violations };
}
