// Pledges data layer (module `pledges`, migrations 0055 / PG 0047). Campaigns are
// staff-authored (localized title and introduction in pledge_campaign_i18n). A
// pledge is stored with its server-calculated plan and one row per planned gift,
// written together in one batch with its first history event, so a pledge never
// exists without its schedule. Planned gifts are intentions, not payments.
// Online submissions carry an idempotency key: a retry with the same fields
// returns the same pledge; the same key with different fields is refused.
import type { AppDb, AppStatement } from './appDb';
import { i18nJoin } from './db';
import { SUPPORTED_LOCALES, isSupportedLocale, type Locale, type SupportedLocale } from './locales';
import {
  householdKey,
  guideTierIndex,
  newPledgeCode,
  readGiftGuide,
  type GiftGuideRow,
  type GivingMethod,
  type PledgePlan,
} from './pledgePlan';

export const PLEDGE_CAMPAIGN_STATUSES = ['draft', 'published', 'archived'] as const;
export type PledgeCampaignStatus = (typeof PLEDGE_CAMPAIGN_STATUSES)[number];

/** Online pledges accepted per email address per rolling day (abuse brake). */
export const PLEDGES_PER_EMAIL_PER_DAY = 5;

// ── Campaigns ────────────────────────────────────────────────────────────────

export interface CampaignText {
  title: string;
  intro: string;
}

export interface CampaignInput {
  slug: string;
  status: PledgeCampaignStatus;
  pledgeOpens: string | null;
  pledgeCloses: string | null;
  givingStart: string;
  givingEnd: string;
  maxMonths: number;
  goalCents: number | null;
  householdGoal: number | null;
  giftGuide: GiftGuideRow[];
  text: Partial<Record<SupportedLocale, CampaignText>>;
  /** Giving fund link: a number or null to set it, undefined to keep the stored value. */
  fundId?: number | null;
  /** ISO currency (lowercase), set once at creation from the church's giving currency. Default 'usd'. */
  currency?: string;
}

export interface CampaignRow {
  id: number;
  slug: string;
  status: PledgeCampaignStatus;
  pledge_opens: string | null;
  pledge_closes: string | null;
  giving_start: string;
  giving_end: string;
  max_months: number;
  goal_cents: number | null;
  household_goal: number | null;
  gift_guide: string;
  currency: string;
  fund_id: number | null;
  title: string;
  intro_md: string;
}

export interface Campaign extends Omit<CampaignRow, 'gift_guide'> {
  giftGuide: GiftGuideRow[];
}

function toCampaign(row: CampaignRow): Campaign {
  const { gift_guide, ...rest } = row;
  return { ...rest, giftGuide: readGiftGuide(gift_guide) };
}

const CAMPAIGN_COLS =
  'c.id, c.slug, c.status, c.pledge_opens, c.pledge_closes, c.giving_start, c.giving_end, c.max_months, c.goal_cents, c.household_goal, c.gift_guide, c.currency, c.fund_id';

function campaignI18nStatements(db: AppDb, id: number, text: CampaignInput['text']): AppStatement[] {
  return SUPPORTED_LOCALES.filter((code) => text[code] !== undefined).map((code) =>
    db
      .prepare(
        `INSERT INTO pledge_campaign_i18n (campaign_id, locale, title, intro_md) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (campaign_id, locale) DO UPDATE SET title = excluded.title, intro_md = excluded.intro_md`,
      )
      .bind(id, code, text[code]!.title, text[code]!.intro),
  );
}

export async function createCampaign(db: AppDb, input: CampaignInput): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO pledge_campaigns (slug, status, pledge_opens, pledge_closes, giving_start, giving_end, max_months, goal_cents, household_goal, gift_guide, fund_id, currency)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id`,
    )
    .bind(
      input.slug,
      input.status,
      input.pledgeOpens,
      input.pledgeCloses,
      input.givingStart,
      input.givingEnd,
      input.maxMonths,
      input.goalCents,
      input.householdGoal,
      JSON.stringify(input.giftGuide),
      input.fundId ?? null,
      input.currency && /^[a-z]{3}$/.test(input.currency) ? input.currency : 'usd',
    )
    .first<{ id: number }>();
  const id = row!.id;
  const stmts = campaignI18nStatements(db, id, input.text);
  if (stmts.length) await db.batch(stmts);
  return id;
}

export async function updateCampaign(db: AppDb, id: number, input: CampaignInput): Promise<boolean> {
  const update = db
    .prepare(
      `UPDATE pledge_campaigns SET slug = ?2, status = ?3, pledge_opens = ?4, pledge_closes = ?5, giving_start = ?6,
              giving_end = ?7, max_months = ?8, goal_cents = ?9, household_goal = ?10, gift_guide = ?11, updated_at = datetime('now')
       WHERE id = ?1`,
    )
    .bind(
      id,
      input.slug,
      input.status,
      input.pledgeOpens,
      input.pledgeCloses,
      input.givingStart,
      input.givingEnd,
      input.maxMonths,
      input.goalCents,
      input.householdGoal,
      JSON.stringify(input.giftGuide),
    );
  const fund = input.fundId === undefined ? [] : [db.prepare('UPDATE pledge_campaigns SET fund_id = ?2 WHERE id = ?1').bind(id, input.fundId)];
  const [result] = await db.batch([update, ...fund, ...campaignI18nStatements(db, id, input.text)]);
  return (result.meta.changes ?? 0) > 0;
}

/** True when another campaign already uses this slug. */
export async function campaignSlugTaken(db: AppDb, slug: string, exceptId: number | null): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM pledge_campaigns WHERE slug = ?1 AND id != ?2`)
    .bind(slug, exceptId ?? 0)
    .first<{ id: number }>();
  return !!row;
}

/** One campaign with its text in the requested language (with fallback). Any status. */
export async function getCampaign(db: AppDb, id: number, locale: Locale): Promise<Campaign | null> {
  const j = i18nJoin('pledge_campaign_i18n', 'c', 'campaign_id', ['title', 'intro_md'], locale);
  const row = await db
    .prepare(`SELECT ${CAMPAIGN_COLS}, ${j.select} FROM pledge_campaigns c ${j.joins} WHERE c.id = ?1`)
    .bind(id)
    .first<CampaignRow>();
  return row ? toCampaign(row) : null;
}

/** Every stored language of a campaign's text, for the editor. */
export async function getCampaignTexts(db: AppDb, id: number): Promise<Partial<Record<SupportedLocale, CampaignText>>> {
  const { results } = await db
    .prepare(`SELECT locale, title, intro_md FROM pledge_campaign_i18n WHERE campaign_id = ?1`)
    .bind(id)
    .all<{ locale: string; title: string; intro_md: string }>();
  const out: Partial<Record<SupportedLocale, CampaignText>> = {};
  for (const r of results) if (isSupportedLocale(r.locale)) out[r.locale] = { title: r.title, intro: r.intro_md };
  return out;
}

export interface CampaignListRow extends Campaign {
  pledge_count: number;
  total_cents: number;
}

/** Admin list: every non-archived campaign first, newest first, with active totals. */
export async function listCampaigns(db: AppDb, locale: Locale): Promise<CampaignListRow[]> {
  const j = i18nJoin('pledge_campaign_i18n', 'c', 'campaign_id', ['title', 'intro_md'], locale);
  const { results } = await db
    .prepare(
      `SELECT ${CAMPAIGN_COLS}, ${j.select},
              (SELECT COUNT(*) FROM pledges p WHERE p.campaign_id = c.id AND p.archived_at IS NULL) AS pledge_count,
              (SELECT COALESCE(SUM(p.total_cents), 0) FROM pledges p WHERE p.campaign_id = c.id AND p.archived_at IS NULL) AS total_cents
       FROM pledge_campaigns c ${j.joins}
       ORDER BY CASE c.status WHEN 'archived' THEN 1 ELSE 0 END, c.id DESC`,
    )
    .all<CampaignRow & { pledge_count: number; total_cents: number }>();
  return results.map((r) => ({ ...toCampaign(r), pledge_count: Number(r.pledge_count), total_cents: Number(r.total_cents) }));
}

/** Published campaigns for the public list, newest first. */
export async function listPublicCampaigns(db: AppDb, locale: Locale): Promise<Campaign[]> {
  const j = i18nJoin('pledge_campaign_i18n', 'c', 'campaign_id', ['title', 'intro_md'], locale);
  const { results } = await db
    .prepare(`SELECT ${CAMPAIGN_COLS}, ${j.select} FROM pledge_campaigns c ${j.joins} WHERE c.status = 'published' ORDER BY c.id DESC`)
    .all<CampaignRow>();
  return results.map(toCampaign);
}

/** A published campaign by slug, or null (drafts and archived campaigns are never public). */
export async function getPublicCampaign(db: AppDb, slug: string, locale: Locale): Promise<Campaign | null> {
  const j = i18nJoin('pledge_campaign_i18n', 'c', 'campaign_id', ['title', 'intro_md'], locale);
  const row = await db
    .prepare(`SELECT ${CAMPAIGN_COLS}, ${j.select} FROM pledge_campaigns c ${j.joins} WHERE c.slug = ?1 AND c.status = 'published'`)
    .bind(slug)
    .first<CampaignRow>();
  return row ? toCampaign(row) : null;
}

export type CampaignPhase = 'upcoming' | 'open' | 'closed';

/** Whether a published campaign's own pledge period accepts pledges today. */
export function campaignPhase(c: Pick<Campaign, 'pledge_opens' | 'pledge_closes'>, today: string): CampaignPhase {
  if (c.pledge_opens && today < c.pledge_opens) return 'upcoming';
  if (c.pledge_closes && today > c.pledge_closes) return 'closed';
  return 'open';
}

// ── Pledges ──────────────────────────────────────────────────────────────────

export interface PledgePerson {
  name: string;
  email: string | null;
  phone: string;
  household: string;
  address: string;
}

export interface PledgeWrite {
  person: PledgePerson;
  plan: PledgePlan;
  givingMethod: GivingMethod;
  givingNote: string;
  signerName: string;
  consent: boolean;
  locale: SupportedLocale;
  staffNote?: string;
}

export interface PledgeRow {
  id: number;
  campaign_id: number;
  code: string;
  pledge_type: 'initial' | 'additional';
  parent_id: number | null;
  parent_code: string | null;
  name: string;
  email: string | null;
  phone: string;
  household: string;
  address: string;
  mode: 'total' | 'installment';
  frequency: PledgePlan['frequency'];
  interval_months: number;
  duration_months: number;
  gift_count: number;
  total_cents: number;
  installment_cents: number;
  final_cents: number;
  start_date: string;
  end_date: string;
  giving_method: GivingMethod;
  giving_note: string;
  signer_name: string;
  consent: number;
  source: 'online' | 'paper';
  locale: string;
  email_status: 'none' | 'pending' | 'sent' | 'failed';
  staff_note: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const PLEDGE_COLS = `p.id, p.campaign_id, p.code, p.pledge_type, p.parent_id, parent.code AS parent_code, p.name, p.email, p.phone,
  p.household, p.address, p.mode, p.frequency, p.interval_months, p.duration_months, p.gift_count, p.total_cents,
  p.installment_cents, p.final_cents, p.start_date, p.end_date, p.giving_method, p.giving_note, p.signer_name,
  p.consent, p.source, p.locale, p.email_status, p.staff_note, p.archived_at, p.created_at, p.updated_at`;

export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  const message = e instanceof Error ? e.message : String(e);
  return code === '23505' || message.includes('UNIQUE constraint failed');
}

/** Stable fingerprint of what a person submitted, so a reused idempotency key with changed fields is caught. */
export async function pledgeFingerprint(fields: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function insertStatements(
  db: AppDb,
  campaignId: number,
  code: string,
  w: PledgeWrite,
  extra: {
    source: 'online' | 'paper';
    pledgeType: 'initial' | 'additional';
    parentId: number | null;
    idempotencyKey: string | null;
    fingerprint: string | null;
    emailStatus: PledgeRow['email_status'];
    actor: string;
  },
): AppStatement[] {
  const p = w.plan;
  const insert = db
    .prepare(
      `INSERT INTO pledges (campaign_id, code, idempotency_key, fingerprint, pledge_type, parent_id, name, email, phone, household,
         address, mode, frequency, interval_months, duration_months, gift_count, total_cents, installment_cents, final_cents,
         start_date, end_date, giving_method, giving_note, signer_name, consent, source, locale, email_status, staff_note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)`,
    )
    .bind(
      campaignId,
      code,
      extra.idempotencyKey,
      extra.fingerprint,
      extra.pledgeType,
      extra.parentId,
      w.person.name,
      w.person.email,
      w.person.phone,
      w.person.household,
      w.person.address,
      p.mode,
      p.frequency,
      p.intervalMonths,
      p.durationMonths,
      p.count,
      p.totalCents,
      p.installmentCents,
      p.finalCents,
      p.startDate,
      p.endDate,
      w.givingMethod,
      w.givingNote,
      w.signerName,
      w.consent ? 1 : 0,
      extra.source,
      w.locale,
      extra.emailStatus,
      w.staffNote ?? '',
    );
  return [insert, ...scheduleStatements(db, code, p), eventStatement(db, code, 'created', extra.actor, [])];
}

function scheduleStatements(db: AppDb, code: string, plan: PledgePlan): AppStatement[] {
  return plan.schedule.map((gift, i) =>
    db
      .prepare(`INSERT INTO pledge_installments (pledge_id, seq, gift_date, amount_cents) SELECT id, ?2, ?3, ?4 FROM pledges WHERE code = ?1`)
      .bind(code, i + 1, gift.date, gift.amountCents),
  );
}

function eventStatement(db: AppDb, code: string, action: string, actor: string, changes: string[]): AppStatement {
  return db
    .prepare(`INSERT INTO pledge_events (pledge_id, action, actor, changes) SELECT id, ?2, ?3, ?4 FROM pledges WHERE code = ?1`)
    .bind(code, action, actor, JSON.stringify(changes));
}

async function insertWithFreshCode(
  db: AppDb,
  build: (code: string) => AppStatement[],
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const code = newPledgeCode();
    try {
      await db.batch(build(code));
      return code;
    } catch (e) {
      // A code collision (one in tens of billions) retries; any other failure is real.
      if (attempt < 3 && isUniqueViolation(e)) {
        const collided = await db.prepare('SELECT 1 AS x FROM pledges WHERE code = ?1').bind(code).first();
        if (collided) continue;
      }
      throw e;
    }
  }
}

export type SubmitResult =
  | { ok: true; id: number; code: string; replay: boolean }
  | { ok: false; error: 'conflict' | 'rate_limited' | 'original_not_found' };

export interface OnlineSubmission extends PledgeWrite {
  idempotencyKey: string;
  fingerprint: string;
  /** For an additional pledge: the code of the person's earlier pledge in this campaign. */
  originalCode: string | null;
  /** UTC 'YYYY-MM-DD HH:MM:SS' one day ago, for the per-email brake. */
  dayAgoUtc: string;
}

async function findByIdempotencyKey(db: AppDb, key: string): Promise<{ id: number; code: string; fingerprint: string | null } | null> {
  return db
    .prepare(`SELECT id, code, fingerprint FROM pledges WHERE idempotency_key = ?1`)
    .bind(key)
    .first<{ id: number; code: string; fingerprint: string | null }>();
}

/** The original an additional pledge adds to: same campaign, active, same email. Chains resolve to the first pledge. */
async function findOriginal(db: AppDb, campaignId: number, code: string, email: string | null): Promise<number | null> {
  if (!email) return null;
  const row = await db
    .prepare(
      `SELECT id, parent_id FROM pledges
       WHERE campaign_id = ?1 AND code = ?2 AND archived_at IS NULL AND lower(trim(email)) = lower(trim(?3))`,
    )
    .bind(campaignId, code, email)
    .first<{ id: number; parent_id: number | null }>();
  return row ? (row.parent_id ?? row.id) : null;
}

/** Store a public online pledge. Never sends mail; the caller does that after success. */
export async function submitOnlinePledge(db: AppDb, campaignId: number, s: OnlineSubmission): Promise<SubmitResult> {
  const existing = await findByIdempotencyKey(db, s.idempotencyKey);
  if (existing) {
    return existing.fingerprint === s.fingerprint
      ? { ok: true, id: existing.id, code: existing.code, replay: true }
      : { ok: false, error: 'conflict' };
  }
  if (s.person.email) {
    const recent = await db
      .prepare(`SELECT COUNT(*) AS n FROM pledges WHERE source = 'online' AND lower(email) = lower(?1) AND created_at > ?2`)
      .bind(s.person.email, s.dayAgoUtc)
      .first<{ n: number }>();
    if (Number(recent?.n ?? 0) >= PLEDGES_PER_EMAIL_PER_DAY) return { ok: false, error: 'rate_limited' };
  }
  let parentId: number | null = null;
  if (s.originalCode !== null) {
    parentId = await findOriginal(db, campaignId, s.originalCode, s.person.email);
    if (parentId === null) return { ok: false, error: 'original_not_found' };
  }
  try {
    const code = await insertWithFreshCode(db, (c) =>
      insertStatements(db, campaignId, c, s, {
        source: 'online',
        pledgeType: parentId ? 'additional' : 'initial',
        parentId,
        idempotencyKey: s.idempotencyKey,
        fingerprint: s.fingerprint,
        emailStatus: s.person.email ? 'pending' : 'none',
        actor: '',
      }),
    );
    const row = await db.prepare('SELECT id FROM pledges WHERE code = ?1').bind(code).first<{ id: number }>();
    return { ok: true, id: row!.id, code, replay: false };
  } catch (e) {
    // Two simultaneous retries of one submission: the loser reads the winner's row.
    if (isUniqueViolation(e)) {
      const again = await findByIdempotencyKey(db, s.idempotencyKey);
      if (again) {
        return again.fingerprint === s.fingerprint
          ? { ok: true, id: again.id, code: again.code, replay: true }
          : { ok: false, error: 'conflict' };
      }
    }
    throw e;
  }
}

/** Staff entry of a paper card (or a pledge taken by phone). No email is sent until staff choose to. */
export async function createPaperPledge(
  db: AppDb,
  campaignId: number,
  w: PledgeWrite,
  actor: string,
  originalCode: string | null,
): Promise<{ ok: true; id: number; code: string } | { ok: false; error: 'original_not_found' }> {
  let parentId: number | null = null;
  if (originalCode) {
    const row = await db
      .prepare(`SELECT id, parent_id FROM pledges WHERE campaign_id = ?1 AND code = ?2 AND archived_at IS NULL`)
      .bind(campaignId, originalCode)
      .first<{ id: number; parent_id: number | null }>();
    if (!row) return { ok: false, error: 'original_not_found' };
    parentId = row.parent_id ?? row.id;
  }
  const code = await insertWithFreshCode(db, (c) =>
    insertStatements(db, campaignId, c, w, {
      source: 'paper',
      pledgeType: parentId ? 'additional' : 'initial',
      parentId,
      idempotencyKey: null,
      fingerprint: null,
      emailStatus: 'none',
      actor,
    }),
  );
  const row = await db.prepare('SELECT id FROM pledges WHERE code = ?1').bind(code).first<{ id: number }>();
  return { ok: true, id: row!.id, code };
}

export async function getPledge(db: AppDb, id: number): Promise<PledgeRow | null> {
  return db
    .prepare(`SELECT ${PLEDGE_COLS} FROM pledges p LEFT JOIN pledges parent ON parent.id = p.parent_id WHERE p.id = ?1`)
    .bind(id)
    .first<PledgeRow>();
}

export async function getPledgeByCode(db: AppDb, code: string): Promise<PledgeRow | null> {
  return db
    .prepare(`SELECT ${PLEDGE_COLS} FROM pledges p LEFT JOIN pledges parent ON parent.id = p.parent_id WHERE p.code = ?1`)
    .bind(code)
    .first<PledgeRow>();
}

export async function listPledges(db: AppDb, campaignId: number, archived: boolean): Promise<PledgeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PLEDGE_COLS} FROM pledges p LEFT JOIN pledges parent ON parent.id = p.parent_id
       WHERE p.campaign_id = ?1 AND ${archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'}
       ORDER BY p.id DESC`,
    )
    .bind(campaignId)
    .all<PledgeRow>();
  return results;
}

export interface InstallmentRow {
  seq: number;
  gift_date: string;
  amount_cents: number;
}

export async function listInstallments(db: AppDb, pledgeId: number): Promise<InstallmentRow[]> {
  const { results } = await db
    .prepare(`SELECT seq, gift_date, amount_cents FROM pledge_installments WHERE pledge_id = ?1 ORDER BY seq`)
    .bind(pledgeId)
    .all<InstallmentRow>();
  return results;
}

export interface PledgeEventRow {
  id: number;
  action: string;
  actor: string;
  changes: string;
  occurred_at: string;
}

export async function listPledgeEvents(db: AppDb, pledgeId: number): Promise<PledgeEventRow[]> {
  const { results } = await db
    .prepare(`SELECT id, action, actor, changes, occurred_at FROM pledge_events WHERE pledge_id = ?1 ORDER BY id DESC`)
    .bind(pledgeId)
    .all<PledgeEventRow>();
  return results;
}

/** Field names compared when staff edit a pledge (only names are written to history). */
function changedFields(before: PledgeRow, w: PledgeWrite): string[] {
  const after: Record<string, unknown> = {
    name: w.person.name,
    email: w.person.email,
    phone: w.person.phone,
    household: w.person.household,
    address: w.person.address,
    mode: w.plan.mode,
    frequency: w.plan.frequency,
    interval_months: w.plan.intervalMonths,
    duration_months: w.plan.durationMonths,
    total_cents: w.plan.totalCents,
    start_date: w.plan.startDate,
    giving_method: w.givingMethod,
    giving_note: w.givingNote,
    signer_name: w.signerName,
    staff_note: w.staffNote ?? '',
  };
  return Object.keys(after).filter((k) => (before as unknown as Record<string, unknown>)[k] !== after[k]);
}

/** Staff edit of an active pledge: replaces its plan and schedule; history records which fields changed. */
export async function updatePledge(db: AppDb, id: number, w: PledgeWrite, actor: string): Promise<'ok' | 'not_found' | 'archived' | 'unchanged'> {
  const before = await getPledge(db, id);
  if (!before) return 'not_found';
  if (before.archived_at) return 'archived';
  const changes = changedFields(before, w);
  if (changes.length === 0) return 'unchanged';
  const p = w.plan;
  await db.batch([
    db
      .prepare(
        `UPDATE pledges SET name = ?2, email = ?3, phone = ?4, household = ?5, address = ?6, mode = ?7, frequency = ?8,
           interval_months = ?9, duration_months = ?10, gift_count = ?11, total_cents = ?12, installment_cents = ?13,
           final_cents = ?14, start_date = ?15, end_date = ?16, giving_method = ?17, giving_note = ?18, signer_name = ?19,
           staff_note = ?20, updated_at = datetime('now')
         WHERE id = ?1 AND archived_at IS NULL`,
      )
      .bind(
        id,
        w.person.name,
        w.person.email,
        w.person.phone,
        w.person.household,
        w.person.address,
        p.mode,
        p.frequency,
        p.intervalMonths,
        p.durationMonths,
        p.count,
        p.totalCents,
        p.installmentCents,
        p.finalCents,
        p.startDate,
        p.endDate,
        w.givingMethod,
        w.givingNote,
        w.signerName,
        w.staffNote ?? '',
      ),
    db.prepare(`DELETE FROM pledge_installments WHERE pledge_id = ?1`).bind(id),
    ...scheduleStatements(db, before.code, p),
    eventStatement(db, before.code, 'edited', actor, changes),
  ]);
  return 'ok';
}

/** Archive (true) or restore (false). Archived pledges leave every total and cannot be edited. */
export async function setPledgeArchived(db: AppDb, id: number, archived: boolean, actor: string): Promise<boolean> {
  const row = await getPledge(db, id);
  if (!row || (row.archived_at !== null) === archived) return false;
  await db.batch([
    db
      .prepare(
        archived
          ? `UPDATE pledges SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1 AND archived_at IS NULL`
          : `UPDATE pledges SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?1 AND archived_at IS NOT NULL`,
      )
      .bind(id),
    eventStatement(db, row.code, archived ? 'archived' : 'restored', actor, []),
  ]);
  return true;
}

export async function recordEmailOutcome(db: AppDb, id: number, sent: boolean, actor: string): Promise<void> {
  const row = await getPledge(db, id);
  if (!row) return;
  await db.batch([
    db.prepare(`UPDATE pledges SET email_status = ?2 WHERE id = ?1`).bind(id, sent ? 'sent' : 'failed'),
    eventStatement(db, row.code, sent ? 'email_sent' : 'email_failed', actor, []),
  ]);
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface CampaignSummary {
  pledgeCount: number;
  totalCents: number;
  households: number;
  byYear: { year: string; amountCents: number }[];
  /** Households per gift-guide row (same order as the guide), plus those below every row. */
  tiers: { households: number; goalHouseholds: number; totalCents: number }[];
  belowGuide: number;
  last7Days: { pledges: number; totalCents: number };
}

/** Totals over a campaign's active (non-archived) pledges. `weekAgoUtc` bounds the "past 7 days" line. */
export async function campaignSummary(db: AppDb, campaign: Campaign, weekAgoUtc: string): Promise<CampaignSummary> {
  const [pledges, years] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT p.name, p.email, p.total_cents, p.created_at, root.name AS root_name, root.email AS root_email
         FROM pledges p LEFT JOIN pledges root ON root.id = p.parent_id
         WHERE p.campaign_id = ?1 AND p.archived_at IS NULL`,
      )
      .bind(campaign.id),
    db
      .prepare(
        `SELECT substr(i.gift_date, 1, 4) AS year, SUM(i.amount_cents) AS amount
         FROM pledge_installments i JOIN pledges p ON p.id = i.pledge_id
         WHERE p.campaign_id = ?1 AND p.archived_at IS NULL
         GROUP BY substr(i.gift_date, 1, 4) ORDER BY year`,
      )
      .bind(campaign.id),
  ]);
  const rows = pledges.results as {
    name: string;
    email: string | null;
    total_cents: number;
    created_at: string;
    root_name: string | null;
    root_email: string | null;
  }[];
  const byHousehold = new Map<string, number>();
  let totalCents = 0;
  let recentCount = 0;
  let recentCents = 0;
  for (const r of rows) {
    const cents = Number(r.total_cents);
    totalCents += cents;
    // An additional pledge counts toward the household of the pledge it adds to.
    const key = householdKey(r.root_name !== null ? { name: r.root_name, email: r.root_email } : r);
    byHousehold.set(key, (byHousehold.get(key) ?? 0) + cents);
    if (r.created_at > weekAgoUtc) {
      recentCount += 1;
      recentCents += cents;
    }
  }
  const tiers = campaign.giftGuide.map((g) => ({ households: 0, goalHouseholds: g.households, totalCents: g.totalCents }));
  let belowGuide = 0;
  for (const total of byHousehold.values()) {
    const i = guideTierIndex(campaign.giftGuide, total);
    if (i < 0) belowGuide += 1;
    else tiers[i].households += 1;
  }
  return {
    pledgeCount: rows.length,
    totalCents,
    households: byHousehold.size,
    byYear: (years.results as { year: string; amount: number }[]).map((y) => ({ year: String(y.year), amountCents: Number(y.amount) })),
    tiers,
    belowGuide,
    last7Days: { pledges: recentCount, totalCents: recentCents },
  };
}
