// Pledge plan arithmetic (pure). A pledge is a written intention to give over a
// period: the person names either the whole amount or one installment, how often,
// for how long, and when to start. The server recomputes every plan from those
// inputs; the browser preview uses the same function, so the two never disagree.
// All money is integer cents; any rounding remainder goes into the last gift.
// Dates are YYYY-MM-DD calendar dates. Every gift, including the last, must fall
// inside the campaign's giving period, and a plan may span at most the campaign's
// maximum number of months.

export const PLEDGE_FREQUENCIES = ['once', 'monthly', 'quarterly', 'yearly', 'custom'] as const;
export type PledgeFrequency = (typeof PLEDGE_FREQUENCIES)[number];
export const PLEDGE_MODES = ['total', 'installment'] as const;
export type PledgeMode = (typeof PLEDGE_MODES)[number];
export const GIVING_METHODS = ['online', 'check', 'cash', 'other'] as const;
export type GivingMethod = (typeof GIVING_METHODS)[number];

/** The largest single pledge the form accepts: $10,000,000.00. */
export const PLEDGE_MAX_CENTS = 1_000_000_000;

const FIXED_INTERVALS: Record<Exclude<PledgeFrequency, 'custom'>, number> = {
  once: 1,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

export interface PledgeBounds {
  givingStart: string;
  givingEnd: string;
  maxMonths: number;
}

export interface PledgePlanInput {
  mode: string;
  amount: string;
  frequency: string;
  durationMonths: number;
  intervalMonths?: number;
  startDate: string;
}

export interface PledgeGift {
  date: string;
  amountCents: number;
}

export interface PledgePlan {
  mode: PledgeMode;
  frequency: PledgeFrequency;
  totalCents: number;
  installmentCents: number;
  finalCents: number;
  count: number;
  intervalMonths: number;
  durationMonths: number;
  startDate: string;
  endDate: string;
  schedule: PledgeGift[];
}

export type PledgePlanError =
  | 'amount'
  | 'mode'
  | 'frequency'
  | 'duration'
  | 'startDate'
  | 'range'
  | 'endDate';

export type PledgePlanResult =
  | { ok: true; plan: PledgePlan }
  | { ok: false; errors: Partial<Record<PledgePlanError, true>> };

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Add calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsClamped(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Parse a dollars-and-cents string ("1200", "1,200.5", "$75.25") into integer cents, or null. */
export function parseAmountCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, decimal = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function isFrequency(value: string): value is PledgeFrequency {
  return (PLEDGE_FREQUENCIES as readonly string[]).includes(value);
}

/**
 * Compute the full plan, or every reason it cannot be made. `durationMonths` is
 * the span the person commits to (ignored for a one-time gift); the number of
 * gifts is ceil(duration / interval).
 */
export function calculatePledgePlan(input: PledgePlanInput, bounds: PledgeBounds): PledgePlanResult {
  const errors: Partial<Record<PledgePlanError, true>> = {};
  const cents = parseAmountCents(String(input.amount ?? ''));
  if (cents === null || cents < 1 || cents > PLEDGE_MAX_CENTS) errors.amount = true;
  const mode = input.mode;
  if (mode !== 'total' && mode !== 'installment') errors.mode = true;
  const frequency = String(input.frequency ?? '');
  const interval = !isFrequency(frequency)
    ? NaN
    : frequency === 'custom'
      ? Number(input.intervalMonths)
      : FIXED_INTERVALS[frequency];
  if (!Number.isInteger(interval) || interval < 1 || interval > bounds.maxMonths) errors.frequency = true;
  const duration = frequency === 'once' ? 1 : Number(input.durationMonths);
  if (!Number.isInteger(duration) || duration < 1 || duration > bounds.maxMonths) errors.duration = true;
  const start = String(input.startDate ?? '');
  if (!isRealDate(start) || start < bounds.givingStart || start > bounds.givingEnd) errors.startDate = true;
  if (Object.keys(errors).length) return { ok: false, errors };

  const freq = frequency as PledgeFrequency;
  const count = freq === 'once' ? 1 : Math.ceil(duration / interval);
  const totalCents = mode === 'total' ? cents! : cents! * count;
  if (totalCents < count || totalCents > PLEDGE_MAX_CENTS) return { ok: false, errors: { range: true } };
  const installmentCents = Math.floor(totalCents / count);
  const schedule: PledgeGift[] = Array.from({ length: count }, (_, i) => ({
    date: addMonthsClamped(start, i * interval),
    amountCents: i === count - 1 ? totalCents - installmentCents * (count - 1) : installmentCents,
  }));
  const endDate = schedule[count - 1].date;
  if (endDate > bounds.givingEnd) return { ok: false, errors: { endDate: true } };
  return {
    ok: true,
    plan: {
      mode: mode as PledgeMode,
      frequency: freq,
      totalCents,
      installmentCents,
      finalCents: schedule[count - 1].amountCents,
      count,
      intervalMonths: interval,
      durationMonths: duration,
      startDate: start,
      endDate,
      schedule,
    },
  };
}

/** One gift-guide row: how many households the campaign hopes will give a total. */
export interface GiftGuideRow {
  households: number;
  totalCents: number;
}

/**
 * Parse the admin's gift-guide textarea: one row per line as "households x amount"
 * ("3 x 5000", "3 × $5,000"). Blank lines are skipped. Returns the rows sorted by
 * amount (largest first), or the 1-based number of the first bad line.
 */
export function parseGiftGuide(text: string): { ok: true; rows: GiftGuideRow[] } | { ok: false; line: number } {
  const rows: GiftGuideRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^(\d{1,5})\s*[x×*]\s*(.+)$/i);
    const households = match ? Number(match[1]) : NaN;
    const cents = match ? parseAmountCents(match[2]) : null;
    if (!match || !Number.isInteger(households) || households < 1 || cents === null || cents < 1 || cents > PLEDGE_MAX_CENTS) {
      return { ok: false, line: i + 1 };
    }
    rows.push({ households, totalCents: cents });
  }
  if (rows.length > 40) return { ok: false, line: 41 };
  rows.sort((a, b) => b.totalCents - a.totalCents);
  return { ok: true, rows };
}

/** The stored gift guide as admin textarea text. */
export function giftGuideText(rows: readonly GiftGuideRow[]): string {
  return rows.map((r) => `${r.households} x ${(r.totalCents / 100).toFixed(2).replace(/\.00$/, '')}`).join('\n');
}

/** Read the JSON column defensively: anything malformed reads as no guide. */
export function readGiftGuide(json: string | null | undefined): GiftGuideRow[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is GiftGuideRow =>
        !!r && typeof r === 'object' && Number.isInteger((r as GiftGuideRow).households) && Number.isInteger((r as GiftGuideRow).totalCents),
    );
  } catch {
    return [];
  }
}

// Eight letters without the easily confused I, L, O, so a code read aloud or
// copied from paper survives. 23^8 ≈ 7.8e10 codes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/** A random pledge code such as "KQWMTRZB". */
export function newPledgeCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = [];
  while (out.length < 8) {
    for (const byte of random(16)) {
      // Reject the top of the byte range so every letter is equally likely.
      if (byte >= 23 * 11) continue;
      out.push(CODE_ALPHABET[byte % 23]);
      if (out.length === 8) break;
    }
  }
  return out.join('');
}

/** Normalize a typed code: uppercase, drop spaces and dashes. */
export function normalizePledgeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export function isPledgeCode(code: string): boolean {
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(code);
}

/**
 * The household a pledge counts toward in goal progress: its email (trimmed,
 * lowercased), or for a paper card without one, its name. An additional pledge
 * counts toward the same household as the person's first.
 */
export function householdKey(p: { email: string | null; name: string }): string {
  const email = (p.email ?? '').trim().toLowerCase();
  if (email) return `e:${email}`;
  return `n:${p.name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

/**
 * Which gift-guide row a household's combined pledge falls into: the largest
 * row whose amount it reaches. Returns the row index, or -1 when below every row.
 */
export function guideTierIndex(rows: readonly GiftGuideRow[], totalCents: number): number {
  for (let i = 0; i < rows.length; i++) if (totalCents >= rows[i].totalCents) return i;
  return -1;
}
