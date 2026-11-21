// Form parsing for the Pledges module (pure; unit-tested). Public and staff
// forms share one parser: staff entry of a paper card relaxes only the fields a
// card may leave blank (email, signature, consent). Every error value is a
// dictionary key, so pages render them in the reader's language.
import { isValidDateStr } from './dates';
import { SUPPORTED_LOCALES, type SupportedLocale } from './locales';
import {
  GIVING_METHODS,
  calculatePledgePlan,
  isPledgeCode,
  normalizePledgeCode,
  parseAmountCents,
  parseGiftGuide,
  PLEDGE_MAX_CENTS,
  type GivingMethod,
  type PledgePlan,
} from './pledgePlan';
import type { Campaign, CampaignInput, CampaignText, PledgeCampaignStatus, PledgeWrite } from './pledgeDb';
import { PLEDGE_CAMPAIGN_STATUSES } from './pledgeDb';

export type FieldErrors = Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(fd: FormData, key: string, max: number): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max + 1) : '';
}

/**
 * The optional Giving fund select. Absent (Giving off, so the field is not
 * rendered) means "keep the stored link"; an empty value clears it.
 */
export function parseFundField(fd: FormData): number | null | undefined | 'invalid' {
  if (!fd.has('fund_id')) return undefined;
  const raw = String(fd.get('fund_id') ?? '').trim();
  if (!raw) return null;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : 'invalid';
}

// ── Campaign editor ──────────────────────────────────────────────────────────

export function parseCampaignForm(fd: FormData): { ok: true; value: CampaignInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const slug = str(fd, 'slug', 80).toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 80) errors.slug = 'pledges.admin.err.slug';
  const status = str(fd, 'status', 20) as PledgeCampaignStatus;
  if (!(PLEDGE_CAMPAIGN_STATUSES as readonly string[]).includes(status)) errors.status = 'pledges.admin.err.status';

  const optionalDate = (key: string): string | null => {
    const v = str(fd, key, 10);
    if (!v) return null;
    if (!isValidDateStr(v)) errors[key] = 'pledges.admin.err.date';
    return v;
  };
  const pledgeOpens = optionalDate('pledge_opens');
  const pledgeCloses = optionalDate('pledge_closes');
  const givingStart = str(fd, 'giving_start', 10);
  const givingEnd = str(fd, 'giving_end', 10);
  if (!isValidDateStr(givingStart)) errors.giving_start = 'pledges.admin.err.date';
  if (!isValidDateStr(givingEnd)) errors.giving_end = 'pledges.admin.err.date';
  if (!errors.giving_start && !errors.giving_end && givingEnd < givingStart) errors.giving_end = 'pledges.admin.err.dateOrder';
  if (pledgeOpens && pledgeCloses && !errors.pledge_opens && !errors.pledge_closes && pledgeCloses < pledgeOpens) {
    errors.pledge_closes = 'pledges.admin.err.dateOrder';
  }

  const maxMonths = Number(str(fd, 'max_months', 4) || '36');
  if (!Number.isInteger(maxMonths) || maxMonths < 1 || maxMonths > 120) errors.max_months = 'pledges.admin.err.maxMonths';

  let goalCents: number | null = null;
  const goalRaw = str(fd, 'goal', 20);
  if (goalRaw) {
    goalCents = parseAmountCents(goalRaw);
    if (goalCents === null || goalCents < 1 || goalCents > PLEDGE_MAX_CENTS * 100) errors.goal = 'pledges.admin.err.amount';
  }
  let householdGoal: number | null = null;
  const hhRaw = str(fd, 'household_goal', 7);
  if (hhRaw) {
    householdGoal = Number(hhRaw);
    if (!Number.isInteger(householdGoal) || householdGoal < 1 || householdGoal > 1_000_000) errors.household_goal = 'pledges.admin.err.count';
  }

  const guide = parseGiftGuide(String(fd.get('gift_guide') ?? '').slice(0, 4000));
  if (!guide.ok) errors.gift_guide = 'pledges.admin.err.giftGuide';

  const text: Partial<Record<SupportedLocale, CampaignText>> = {};
  for (const code of SUPPORTED_LOCALES) {
    if (!fd.has(`title_${code}`) && !fd.has(`intro_${code}`)) continue;
    text[code] = { title: str(fd, `title_${code}`, 200), intro: str(fd, `intro_${code}`, 8000) };
    if (text[code]!.title.length > 200) errors.title = 'pledges.admin.err.tooLong';
  }
  if (!Object.values(text).some((v) => v && v.title)) errors.title = 'pledges.admin.err.title';

  const fundId = parseFundField(fd);
  if (fundId === 'invalid') errors.fund_id = 'pledges.admin.err.fund';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(fundId !== undefined && fundId !== 'invalid' ? { fundId } : {}),
      slug,
      status,
      pledgeOpens,
      pledgeCloses,
      givingStart,
      givingEnd,
      maxMonths,
      goalCents,
      householdGoal,
      giftGuide: guide.ok ? guide.rows : [],
      text,
    },
  };
}

// ── Pledge form (public and staff) ───────────────────────────────────────────

export interface PledgeFormValue {
  write: PledgeWrite;
  /** Code of the earlier pledge an additional pledge adds to, or null for a first pledge. */
  originalCode: string | null;
  idempotencyKey: string;
  /** The submitted fields used for the replay fingerprint. */
  fingerprintFields: Record<string, unknown>;
}

export interface PledgeFormOptions {
  /** Staff entering a paper card: email, signature and consent become optional. */
  staff: boolean;
  locale: SupportedLocale;
}

const PLAN_ERROR_FIELD: Record<string, string> = {
  amount: 'amount',
  mode: 'mode',
  frequency: 'frequency',
  duration: 'duration_months',
  startDate: 'start_date',
  range: 'amount',
  endDate: 'duration_months',
};

/**
 * Parse a pledge form against a campaign's giving period. The plan is always
 * recalculated here; nothing the browser computed is trusted.
 */
export function parsePledgeForm(
  fd: FormData,
  campaign: Pick<Campaign, 'giving_start' | 'giving_end' | 'max_months'>,
  opts: PledgeFormOptions,
): { ok: true; value: PledgeFormValue } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const name = str(fd, 'name', 120);
  const emailRaw = str(fd, 'email', 254).toLowerCase();
  const phone = str(fd, 'phone', 40);
  const household = str(fd, 'household', 120);
  const address = str(fd, 'address', 300);
  if (!name) errors.name = 'pledges.err.name';
  else if (name.length > 120) errors.name = 'pledges.err.tooLong';
  if (emailRaw ? !EMAIL_RE.test(emailRaw) || emailRaw.length > 254 : !opts.staff) errors.email = 'pledges.err.email';
  for (const [key, value, max] of [['phone', phone, 40], ['household', household, 120], ['address', address, 300]] as const) {
    if (value.length > max) errors[key] = 'pledges.err.tooLong';
  }

  const pledgeType = str(fd, 'pledge_type', 12) || 'initial';
  let originalCode: string | null = null;
  if (pledgeType === 'additional') {
    originalCode = normalizePledgeCode(str(fd, 'original_code', 20));
    if (!isPledgeCode(originalCode)) errors.original_code = 'pledges.err.originalCode';
  } else if (pledgeType !== 'initial') {
    errors.pledge_type = 'pledges.err.option';
  }

  const planResult = calculatePledgePlan(
    {
      mode: str(fd, 'mode', 12),
      amount: str(fd, 'amount', 24),
      frequency: str(fd, 'frequency', 12),
      durationMonths: Number(str(fd, 'duration_months', 4)),
      intervalMonths: Number(str(fd, 'interval_months', 4) || '1'),
      startDate: str(fd, 'start_date', 10),
    },
    { givingStart: campaign.giving_start, givingEnd: campaign.giving_end, maxMonths: campaign.max_months },
  );
  let plan: PledgePlan | null = null;
  if (planResult.ok) plan = planResult.plan;
  else for (const key of Object.keys(planResult.errors)) errors[PLAN_ERROR_FIELD[key]] = `pledges.err.plan.${key}`;

  const givingMethod = str(fd, 'giving_method', 12) as GivingMethod;
  if (!(GIVING_METHODS as readonly string[]).includes(givingMethod)) errors.giving_method = 'pledges.err.option';
  const givingNote = str(fd, 'giving_note', 200);
  if (givingMethod === 'other' && !givingNote) errors.giving_note = 'pledges.err.givingNote';
  if (givingNote.length > 200) errors.giving_note = 'pledges.err.tooLong';

  // The typed signature stands in for a handwritten one: it must match the name.
  const signerName = str(fd, 'signer_name', 120);
  const consent = fd.get('consent') === 'on' || fd.get('consent') === '1';
  if (!opts.staff) {
    const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!signerName || norm(signerName) !== norm(name)) errors.signer_name = 'pledges.err.signature';
    if (!consent) errors.consent = 'pledges.err.consent';
  } else if (signerName.length > 120) {
    errors.signer_name = 'pledges.err.tooLong';
  }
  const staffNote = opts.staff ? str(fd, 'staff_note', 1000) : '';

  const idempotencyKey = str(fd, 'idempotency_key', 36);
  if (!opts.staff && !UUID_RE.test(idempotencyKey)) errors.form = 'pledges.err.expired';

  if (Object.keys(errors).length || !plan) return { ok: false, errors };
  const write: PledgeWrite = {
    person: { name, email: emailRaw || null, phone, household, address },
    plan,
    givingMethod,
    givingNote,
    signerName,
    consent,
    locale: opts.locale,
    staffNote,
  };
  return {
    ok: true,
    value: {
      write,
      originalCode,
      idempotencyKey,
      fingerprintFields: {
        name,
        email: emailRaw,
        phone,
        household,
        address,
        originalCode,
        mode: plan.mode,
        totalCents: plan.totalCents,
        frequency: plan.frequency,
        interval: plan.intervalMonths,
        duration: plan.durationMonths,
        start: plan.startDate,
        givingMethod,
        givingNote,
        signerName,
      },
    },
  };
}
