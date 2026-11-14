// Pure Service Planning logic (no database, no Astro): the run-sheet clock, the
// availability status of a person for a time slot, and the "find a time" search.
// Times are minutes from midnight and all intervals are half-open [start, end), so
// a rehearsal that ends at 10:00 does not collide with one that starts at 10:00.

export const MAX_SEARCH_DAYS = 31;
export const SEARCH_STEP_MIN = 30;
export const MAX_CANDIDATES = 12;
export const MAX_ITEM_MINUTES = 720;

// ── Time helpers ──

/** 'HH:MM' → minutes from midnight, or null when malformed / out of range. */
export function parseHM(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes from midnight → 'HH:MM' (wraps past midnight). */
export function formatHM(totalMinutes: number): string {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd). */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 0 (Sunday) .. 6 (Saturday) for a 'YYYY-MM-DD' date, UTC-anchored. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// ── Run sheet clock ──

export type RunItemKind = 'segment' | 'song' | 'heading' | 'note';

export interface RunItemInput {
  id: number;
  kind: RunItemKind;
  duration_min: number;
  fixed_start_time: string | null;
}

export interface RunItemTiming {
  id: number;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  /** True when a fixed start is earlier than the running clock (items overlap). */
  overlap: boolean;
  /** Minutes of overlap when `overlap` is true. */
  overlapMin: number;
}

export interface RunSheetSummary {
  startMin: number;
  endMin: number;
  end: string;
  totalMin: number;
  targetEnd: string | null;
  /** Minutes past the target end (0 when there is no target or it is met). */
  overrunMin: number;
  overrun: boolean;
  overlapCount: number;
}

/**
 * Start times for an ordered run sheet. The clock starts at the event start and
 * advances by each item's duration; an item with a fixed start jumps the clock to
 * that time (and is flagged when that is earlier than where the clock already
 * was). The summary compares the final clock to the optional target end.
 */
export function computeRunSheet(
  event: { start_time: string; end_time: string | null },
  items: readonly RunItemInput[],
): { rows: RunItemTiming[]; summary: RunSheetSummary } {
  const startMin = parseHM(event.start_time) ?? 0;
  let clock = startMin;
  let latest = startMin;
  const rows: RunItemTiming[] = [];
  for (const item of items) {
    const fixed = parseHM(item.fixed_start_time);
    let overlap = false;
    let overlapMin = 0;
    if (fixed !== null) {
      if (fixed < clock) {
        overlap = true;
        overlapMin = clock - fixed;
      }
      clock = fixed;
    }
    const duration = Math.max(0, Math.min(MAX_ITEM_MINUTES, Math.trunc(item.duration_min) || 0));
    const itemStart = clock;
    clock += duration;
    latest = Math.max(latest, clock);
    rows.push({
      id: item.id,
      startMin: itemStart,
      endMin: clock,
      start: formatHM(itemStart),
      end: formatHM(clock),
      overlap,
      overlapMin,
    });
  }
  const targetEndMin = parseHM(event.end_time);
  const overrunMin = targetEndMin !== null && latest > targetEndMin ? latest - targetEndMin : 0;
  return {
    rows,
    summary: {
      startMin,
      endMin: latest,
      end: formatHM(latest),
      totalMin: latest - startMin,
      targetEnd: targetEndMin !== null ? formatHM(targetEndMin) : null,
      overrunMin,
      overrun: overrunMin > 0,
      overlapCount: rows.filter((row) => row.overlap).length,
    },
  };
}

// ── Optimistic lock ──

/** True when the revision the editor loaded is still the stored one. */
export function revisionMatches(expected: number, actual: number): boolean {
  return Number.isInteger(expected) && expected === actual;
}

// ── Availability windows ──

export interface AvailabilityWindow {
  starts_on: string;
  ends_on: string;
  /** Comma list ('0,3') or JSON array text ('[0,3]'); empty = every day. */
  weekdays: string;
  start_minute: number;
  end_minute: number;
}

/** Normalise stored weekdays text to a sorted, deduplicated list of 0..6. */
export function parseWeekdays(value: string | null | undefined): number[] {
  const raw = (value ?? '').trim();
  if (!raw) return [];
  const body = raw.replace(/^\[/, '').replace(/\]$/, '');
  const days = new Set<number>();
  for (const part of body.split(',')) {
    const trimmed = part.trim().replace(/^"|"$/g, '');
    if (/^[0-6]$/.test(trimmed)) days.add(Number(trimmed));
  }
  return [...days].sort((a, b) => a - b);
}

export function serializeWeekdays(days: readonly number[]): string {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b).join(',');
}

/** Does the window apply on `date` (range + weekday), ignoring the time of day? */
export function windowAppliesOn(window: AvailabilityWindow, date: string): boolean {
  if (date < window.starts_on || date > window.ends_on) return false;
  const days = parseWeekdays(window.weekdays);
  return days.length === 0 || days.includes(weekdayOf(date));
}

/** Does one window fully contain the slot [startMin, endMin) on `date`? */
export function windowCovers(window: AvailabilityWindow, date: string, startMin: number, endMin: number): boolean {
  return windowAppliesOn(window, date) && window.start_minute <= startMin && endMin <= window.end_minute;
}

// ── Status of one person for one slot ──

export type SlotStatus = 'blocked' | 'busy' | 'available' | 'unknown';

export interface BlockoutFact {
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
}

export interface BusyFact {
  date: string;
  startMin: number;
  endMin: number;
}

export interface PersonFacts {
  blockouts: readonly BlockoutFact[];
  busy: readonly BusyFact[];
  windows: readonly AvailabilityWindow[];
}

export const EMPTY_FACTS: PersonFacts = { blockouts: [], busy: [], windows: [] };

/** Does a blockout cover any part of the slot? A blockout without a time range blocks the whole day. */
function blockoutHits(b: BlockoutFact, date: string, startMin: number, endMin: number): boolean {
  if (date < b.start_date || date > b.end_date) return false;
  const from = parseHM(b.start_time);
  const to = parseHM(b.end_time);
  if (from === null || to === null) return true;
  return overlaps(startMin, endMin, from, to);
}

/**
 * Precedence: blocked (a blockout) > busy (another commitment) > available (a
 * window covers the whole slot) > unknown. Intervals are half-open.
 */
export function timeStatus(facts: PersonFacts, date: string, startMin: number, endMin: number): SlotStatus {
  if (facts.blockouts.some((b) => blockoutHits(b, date, startMin, endMin))) return 'blocked';
  if (facts.busy.some((b) => b.date === date && overlaps(startMin, endMin, b.startMin, b.endMin))) return 'busy';
  if (facts.windows.some((w) => windowCovers(w, date, startMin, endMin))) return 'available';
  return 'unknown';
}

// ── Find a time ──

export interface FindCandidatesInput {
  dateFrom: string;
  dateTo: string;
  durationMin: number;
  /** Allowed weekdays (0..6); empty/undefined = any day. */
  weekdays?: readonly number[];
  /** Earliest start / latest end, minutes from midnight. */
  earliestMin?: number;
  latestMin?: number;
  people: readonly number[];
  facts: ReadonlyMap<number, PersonFacts>;
  limit?: number;
}

export interface Candidate {
  date: string;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  statuses: Record<number, SlotStatus>;
  /** blocked + busy people (cannot attend). */
  conflicts: number;
  blocked: number;
  busy: number;
  unknown: number;
  available: number;
}

function addDaysUtc(date: string, n: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Candidate slots in [dateFrom, dateTo] (at most {@link MAX_SEARCH_DAYS} days,
 * {@link SEARCH_STEP_MIN}-minute steps) ranked by fewest blocked people, then
 * fewest unknown, then earliest. "Blocked" counts both blockouts and busy
 * commitments, since either one means the person cannot come.
 */
export function findCandidates(input: FindCandidatesInput): Candidate[] {
  const duration = Math.trunc(input.durationMin);
  if (!Number.isFinite(duration) || duration < 15 || duration > 600) return [];
  const earliest = Math.max(0, input.earliestMin ?? 8 * 60);
  const latest = Math.min(1440, input.latestMin ?? 21 * 60);
  const weekdaySet = new Set(input.weekdays ?? []);
  const out: Candidate[] = [];
  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset++) {
    const date = addDaysUtc(input.dateFrom, offset);
    if (date > input.dateTo) break;
    if (weekdaySet.size > 0 && !weekdaySet.has(weekdayOf(date))) continue;
    for (let start = earliest; start + duration <= latest; start += SEARCH_STEP_MIN) {
      const end = start + duration;
      const statuses: Record<number, SlotStatus> = {};
      let blocked = 0;
      let busy = 0;
      let unknown = 0;
      let available = 0;
      for (const personId of input.people) {
        const status = timeStatus(input.facts.get(personId) ?? EMPTY_FACTS, date, start, end);
        statuses[personId] = status;
        if (status === 'blocked') blocked++;
        else if (status === 'busy') busy++;
        else if (status === 'unknown') unknown++;
        else available++;
      }
      out.push({
        date,
        startMin: start,
        endMin: end,
        start: formatHM(start),
        end: formatHM(end),
        statuses,
        conflicts: blocked + busy,
        blocked,
        busy,
        unknown,
        available,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.conflicts - b.conflicts ||
      a.unknown - b.unknown ||
      a.date.localeCompare(b.date) ||
      a.startMin - b.startMin,
  );
  return out.slice(0, input.limit ?? MAX_CANDIDATES);
}

/** The most-severe status per slot across people: summary used when publishing. */
export function summarizeStatuses(statuses: Record<number, SlotStatus>): {
  blocked: number[];
  busy: number[];
  unknown: number[];
} {
  const blocked: number[] = [];
  const busy: number[] = [];
  const unknown: number[] = [];
  for (const [id, status] of Object.entries(statuses)) {
    if (status === 'blocked') blocked.push(Number(id));
    else if (status === 'busy') busy.push(Number(id));
    else if (status === 'unknown') unknown.push(Number(id));
  }
  return { blocked, busy, unknown };
}

// ── One person on one day (team availability calendar) ──

export interface DayAvailability {
  /** Blockout ranges touching the day; allDay when the blockout has no time range. */
  blocked: { allDay: boolean; start: string | null; end: string | null }[];
  busy: { start: string; end: string }[];
  available: { start: string; end: string }[];
}

export function dayAvailability(facts: PersonFacts, date: string): DayAvailability {
  const blocked = facts.blockouts
    .filter((b) => date >= b.start_date && date <= b.end_date)
    .map((b) => {
      const from = parseHM(b.start_time);
      const to = parseHM(b.end_time);
      return from === null || to === null
        ? { allDay: true, start: null, end: null }
        : { allDay: false, start: formatHM(from), end: formatHM(to) };
    });
  const busy = facts.busy
    .filter((b) => b.date === date)
    .map((b) => ({ start: formatHM(b.startMin), end: formatHM(b.endMin) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const available = facts.windows
    .filter((w) => windowAppliesOn(w, date))
    .map((w) => ({ start: formatHM(w.start_minute), end: formatHM(w.end_minute) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  return { blocked, busy, available };
}

/** The Monday-less week containing `date`: Sunday through Saturday as ISO dates. */
export function weekDates(date: string): string[] {
  const start = addDaysUtc(date, -weekdayOf(date));
  return Array.from({ length: 7 }, (_, i) => addDaysUtc(start, i));
}

/** Every date of a 'YYYY-MM' month. */
export function monthDates(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
}
