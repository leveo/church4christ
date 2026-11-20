// The registration event page's server side, kept out of the Astro page so every gate can be tested against a
// real database: the roster query-string parser, the form builder save, and ONE action dispatcher.
//
// Access (see regAccess.ts): every action names the capability it needs BEFORE anything is read or changed:
//   view     roster, overview, drawer, duplicates, activity (reads; no action uses it yet, listed for the matrix)
//   manage   edits, decisions, cancels, manual add, notes, resend, bulk email   (per-event registrar, or area access)
//   edit     event settings side: the builder, per-event roles, event admins    (registration area only)
//   refund   refunds                                                            (payment operations + manage)
// Then the event is DERIVED from the row the action targets (registration -> event, attendee -> registration ->
// event) and must equal the page's event, else 404: an id from the client is never trusted to name its event.
// The writers in regAdmin.ts send nothing, so this dispatcher mails after a successful write (decision,
// cancellation, promotion, confirmation) and awaits it before answering. Never throws on a refused request.
import type { AppDb } from './appDb';
import type { DbEnv } from './dbProvider';
import { getBackend } from './dbProvider';
import type { Locale } from './locales';
import type { SessionUser } from './types';
import type { StripeEnv } from './stripe';
import { parseAmountToCents } from './givingCheckout';
import {
  canEditEvent, canRefund, eventOfAttendee, eventOfRegistration, grantEventRole, requireRegRole, revokeEventRole,
} from './regAccess';
import {
  adminAddPerson, adminCancelRegistration, adminChangeTicketType, adminCreateRegistration, adminMoveStatus, adminRemovePerson,
  adminSetNote, adminUpdateRegistration, decideRegistration, listRoster,
  type AdminEditInput, type Decision, type OpFailure, type RosterOptions, type RosterPage, type RosterRow, type RosterSort,
} from './regAdmin';
import { logActivity } from './regAdminCore';
import { listQuestions, type RegQuestion, type RegStatus } from './regDb';
import { saveFormRequest, type FormSaveResponse } from './regFormSave';
import { drainOutbox, DRAIN_ON_REQUEST, queueBulkEmail } from './regMessaging';
import { notifyAfterRelease, sendConfirmation, sendDecision, type RegNotifyEnv } from './regNotify';
import { bulkAudience } from './regOutbox';
import { recordOfflineRefund, refundRegistration } from './regRefunds';
import { addEventAdmin, removeEventAdmin } from './prayerDb';
import { LOGISTICS_ACTIONS, runLogisticsAction, type LogisticsScope } from './regLogisticsPage';
import type { SeatingPlan } from './regSeatPlanner';

export type RegActionEnv = RegNotifyEnv & StripeEnv & DbEnv;

export interface RegActionContext {
  db: AppDb;
  env: RegActionEnv;
  user: SessionUser;
  /** The event of the page being acted on (from the URL). */
  eventId: number;
  /** Event admins (the prayer-approval console) exist only under the member portal module. */
  portal: boolean;
  /** The event-logistics module is on for this campus (logisticsModuleEnabled); its actions answer 404 otherwise. */
  logistics?: boolean;
  defaultLocale: Locale;
  /** Injected in tests so a Stripe call never leaves the process. */
  fetcher?: typeof fetch;
}

// ── The action table ─────────────────────────────────────────────────────────

export type ActionNeed = 'view' | 'manage' | 'edit' | 'refund';
export interface ActionSpec { need: ActionNeed; target: 'registration' | 'event'; logistics?: LogisticsScope }

/** Every POST the event page accepts. The security tests walk this table, so a new action cannot skip a gate. */
export const REG_ADMIN_ACTIONS: Readonly<Record<string, ActionSpec>> = {
  edit: { need: 'manage', target: 'registration' },
  change_ticket: { need: 'manage', target: 'registration' },
  add_person: { need: 'manage', target: 'registration' },
  remove_person: { need: 'manage', target: 'registration' },
  cancel: { need: 'manage', target: 'registration' },
  move: { need: 'manage', target: 'registration' },
  decide: { need: 'manage', target: 'registration' },
  resend: { need: 'manage', target: 'registration' },
  note: { need: 'manage', target: 'registration' },
  create: { need: 'manage', target: 'event' },
  bulk_preview: { need: 'manage', target: 'event' },
  bulk_send: { need: 'manage', target: 'event' },
  refund: { need: 'refund', target: 'registration' },
  offline_refund: { need: 'refund', target: 'registration' },
  grant_role: { need: 'edit', target: 'event' },
  revoke_role: { need: 'edit', target: 'event' },
  addEventAdmin: { need: 'edit', target: 'event' },
  removeEventAdmin: { need: 'edit', target: 'event' },
  // Event logistics (housing, tables, groups, tags): regLogisticsPage.ts runs them after the same gate.
  ...LOGISTICS_ACTIONS,
};

export type ActionOutcome =
  | { kind: 'denied'; status: 403 | 404 }
  | { kind: 'bad_request' }
  /** Done: redirect back to the page with a notice (and the registration to keep open). */
  | { kind: 'ok'; notice: string; reg?: number; extra?: Record<string, string> }
  /** The registration changed under the person ("someone else changed this"). */
  | { kind: 'conflict'; reg: number | null }
  /** Over a limit: show the reason (every reason in `reasons` when several apply) and a "do it anyway" form that
   *  replays `fields` with confirm=1. */
  | { kind: 'confirm'; reason: string; reasons?: string[]; fields: Array<[string, string]>; reg: number | null }
  /** A staff reason is needed (moving someone who is checked in): replay `fields` with a `reason` the person types. */
  | { kind: 'reason'; fields: Array<[string, string]> }
  /** Auto-seat preview: the plan, the data stamp it was made from, and the option fields to apply it with. */
  | { kind: 'seat_preview'; stamp: string; plan: SeatingPlan; fields: Array<[string, string]> }
  /** Bulk email preview: how many would get it, and the form fields to send it. */
  | { kind: 'preview'; count: number; fields: Array<[string, string]> }
  | { kind: 'invalid'; code: string; errors: Array<{ path: string; code: string }>; reg: number | null }
  | { kind: 'failed'; code: string; reg: number | null };

const str = (fd: FormData, name: string): string => {
  const value = fd.get(name);
  return typeof value === 'string' ? value : '';
};
const int = (fd: FormData, name: string): number | null => {
  const raw = str(fd, name).trim();
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
};
const flag = (fd: FormData, name: string): boolean => fd.getAll(name).some((v) => v === '1' || v === 'on');

function fieldsOf(fd: FormData): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of fd.entries()) if (typeof value === 'string' && key !== 'confirm') out.push([key, value]);
  return out;
}

/** Translate a writer's refusal into the outcome the page renders. */
function refusal(fd: FormData, failure: OpFailure & { errors?: Array<{ path: string; code: string }> }, reg: number | null): ActionOutcome {
  if (failure.code === 'version_conflict') return { kind: 'conflict', reg };
  if (failure.code === 'NEEDS_CONFIRM') return { kind: 'confirm', reason: String((failure as { reason?: string }).reason ?? 'capacity'), fields: fieldsOf(fd), reg };
  if (failure.code === 'invalid' || (failure.errors && failure.errors.length > 0)) {
    return { kind: 'invalid', code: failure.code, errors: failure.errors ?? [], reg };
  }
  return { kind: 'failed', code: failure.code, reg };
}

// ── Answers from the forms ───────────────────────────────────────────────────

/** One question's answer from a form field (a checkbox arrives as several values). */
function answerOf(fd: FormData, name: string, question: Pick<RegQuestion, 'type'>): string | string[] {
  if (question.type === 'checkbox') return fd.getAll(name).filter((v): v is string => typeof v === 'string');
  return str(fd, name);
}

function answersOf(fd: FormData, prefix: string, questions: RegQuestion[], scope: RegQuestion['scope']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of questions) if (q.scope === scope && q.type !== 'section') out[String(q.id)] = answerOf(fd, `${prefix}${q.id}`, q);
  return out;
}

function parseEdit(fd: FormData, questions: RegQuestion[], version: number): AdminEditInput {
  const input: AdminEditInput = { version };
  if (fd.has('contact_name') || fd.has('contact_email') || fd.has('contact_phone')) {
    input.contact = {
      ...(fd.has('contact_name') ? { name: str(fd, 'contact_name') } : {}),
      ...(fd.has('contact_email') ? { email: str(fd, 'contact_email') } : {}),
      ...(fd.has('contact_phone') ? { phone: str(fd, 'contact_phone') } : {}),
    };
  }
  const attendees: NonNullable<AdminEditInput['attendees']> = [];
  const ids = new Set<number>();
  for (const key of fd.keys()) {
    const m = /^att_(\d+)_(name|answers)$/.exec(key);
    if (m) ids.add(Number(m[1]));
  }
  for (const id of [...ids].sort((a, b) => a - b)) {
    attendees.push({
      id,
      ...(fd.has(`att_${id}_name`) ? { name: str(fd, `att_${id}_name`) } : {}),
      ...(fd.has(`att_${id}_answers`) ? { answers: answersOf(fd, `att_${id}_q_`, questions, 'attendee') } : {}),
    });
  }
  if (attendees.length > 0) input.attendees = attendees;
  if (fd.has('reg_answers')) input.answers = answersOf(fd, 'q_', questions, 'registration');
  return input;
}

const MANUAL_ROWS = 20;

function parseManual(fd: FormData, questions: RegQuestion[], eventId: number, locale: Locale) {
  const attendees: Array<{ name: string; ticketTypeId: number | null; answers: Record<string, string | string[]> }> = [];
  for (let i = 0; i < MANUAL_ROWS; i++) {
    // Row 0 is always the contact; later rows exist only when posted.
    if (i > 0 && !fd.has(`p${i}_name`) && !fd.has(`p${i}_ticket`)) continue;
    attendees.push({
      name: str(fd, `p${i}_name`),
      ticketTypeId: int(fd, `p${i}_ticket`),
      answers: answersOf(fd, `p${i}_q_`, questions, 'attendee'),
    });
  }
  const method = str(fd, 'payment_method');
  const amount = str(fd, 'amount').trim();
  return {
    eventId,
    contact: { name: str(fd, 'contact_name'), email: str(fd, 'contact_email'), phone: str(fd, 'contact_phone') },
    attendees,
    answers: answersOf(fd, 'q_', questions, 'registration'),
    locale,
    ...(method === 'offline' || method === 'comp' ? { paymentMethod: method as 'offline' | 'comp' } : {}),
    ...(method === 'offline' && amount !== '' ? { amountCents: parseAmountToCents(amount) ?? -1 } : {}),
  };
}

// ── The dispatcher ───────────────────────────────────────────────────────────

const DECISIONS: readonly Decision[] = ['accept', 'waitlist', 'decline'];

/** Run one POSTed action of the event page, gate first. */
export async function runRegAdminAction(ctx: RegActionContext, fd: FormData): Promise<ActionOutcome> {
  const { db, env, user, eventId } = ctx;
  const action = str(fd, 'action');
  const spec = REG_ADMIN_ACTIONS[action];

  // 1. The capability, before anything is read (an unknown action asks for the strongest ordinary one).
  const need = spec?.need ?? 'manage';
  const role = await requireRegRole(db, user, eventId, need === 'view' ? 'view' : 'manage');
  if (!role.ok) return { kind: 'denied', status: role.status };
  if (need === 'edit' && !canEditEvent(user)) return { kind: 'denied', status: 403 };
  if (need === 'refund' && !canRefund(user)) return { kind: 'denied', status: 403 };
  if (!spec) return { kind: 'bad_request' };
  // Logistics: the module, the event and its area switch, then the data layer (which owns the cross-event check).
  if (spec.logistics) return runLogisticsAction({ db, eventId, actor: user.id, logistics: ctx.logistics === true }, fd, action);

  // 2. The event comes from the target row, never from the client.
  let rid: number | null = null;
  if (spec.target === 'registration') {
    rid = int(fd, 'registration_id');
    if (rid === null || (await eventOfRegistration(db, rid)) !== eventId) return { kind: 'denied', status: 404 };
    if (fd.has('attendee_id')) {
      const attendeeId = int(fd, 'attendee_id');
      const owner = attendeeId === null ? null : await eventOfAttendee(db, attendeeId);
      if (!owner || owner.eventId !== eventId || owner.registrationId !== rid) return { kind: 'denied', status: 404 };
    }
  }
  const actor = user.id;
  const version = int(fd, 'version');
  const confirm = flag(fd, 'confirm');
  const needVersion = (): ActionOutcome | null => (version === null || version < 1 ? { kind: 'failed', code: 'invalid', reg: rid } : null);
  const done = (notice: string, extra?: Record<string, string>): ActionOutcome => ({ kind: 'ok', notice, ...(rid !== null ? { reg: rid } : {}), ...(extra ? { extra } : {}) });

  switch (action) {
    case 'edit': {
      const bad = needVersion();
      if (bad) return bad;
      const questions = await listQuestions(db, ctx.defaultLocale, eventId);
      const result = await adminUpdateRegistration(db, rid!, parseEdit(fd, questions, version!), { actor });
      return result.ok ? done('saved') : refusal(fd, result, rid);
    }
    case 'change_ticket': {
      const bad = needVersion();
      if (bad) return bad;
      const result = await adminChangeTicketType(
        db, rid!, { version: version!, attendeeId: int(fd, 'attendee_id') ?? 0, ticketTypeId: int(fd, 'ticket_type_id') ?? 0 }, { actor, confirm },
      );
      return result.ok ? done('saved') : refusal(fd, result, rid);
    }
    case 'add_person': {
      const bad = needVersion();
      if (bad) return bad;
      const result = await adminAddPerson(db, rid!, { version: version!, name: str(fd, 'name'), ticketTypeId: int(fd, 'ticket_type_id') }, { actor, confirm });
      return result.ok ? done('person_added') : refusal(fd, result, rid);
    }
    case 'remove_person': {
      const bad = needVersion();
      if (bad) return bad;
      const attendeeId = int(fd, 'attendee_id') ?? 0;
      const row = await db.prepare(`SELECT name FROM reg_attendees WHERE id = ?1`).bind(attendeeId).first<{ name: string }>();
      const result = await adminRemovePerson(db, rid!, { version: version!, attendeeId }, { actor });
      if (!result.ok) return refusal(fd, result, rid);
      await notifyAfterRelease(env, db, {
        cancelledId: rid!, ...(result.registrationCancelled || !row ? {} : { attendeeName: row.name }), promoted: result.promoted,
      });
      return done('person_removed');
    }
    case 'cancel': {
      // The version is optional here (the plain "Cancel" button of the roster); the drawer passes it.
      const result = await adminCancelRegistration(db, rid!, version !== null ? { version } : {}, { actor });
      if (!result.ok) return refusal(fd, result, rid);
      await notifyAfterRelease(env, db, { cancelledId: rid!, promoted: result.promoted });
      return done('cancelled');
    }
    case 'move': {
      const bad = needVersion();
      if (bad) return bad;
      const to = str(fd, 'to');
      if (to !== 'waitlist' && to !== 'confirmed') return { kind: 'bad_request' };
      const result = await adminMoveStatus(db, rid!, { version: version!, to }, { actor, confirm });
      if (!result.ok) return refusal(fd, result, rid);
      await notifyAfterRelease(env, db, { promoted: result.promoted });
      return done('moved');
    }
    case 'decide': {
      const decision = str(fd, 'decision') as Decision;
      if (!DECISIONS.includes(decision)) return { kind: 'bad_request' };
      const result = await decideRegistration(db, rid!, decision, actor, { ...(version !== null ? { version } : {}), confirm });
      if (!result.ok) return refusal(fd, result, rid);
      await sendDecision(env, db, result);
      return done(`decided_${decision}`);
    }
    case 'resend': {
      const sent = await sendConfirmation(env, db, rid!);
      if (!sent) return { kind: 'failed', code: 'resend_failed', reg: rid };
      await logActivity(db, rid!, actor, 'resent');
      return done('resent');
    }
    case 'note': {
      const bad = needVersion();
      if (bad) return bad;
      const result = await adminSetNote(db, rid!, { version: version!, note: str(fd, 'note') }, { actor });
      return result.ok ? done('saved') : refusal(fd, result, rid);
    }
    case 'create': {
      const questions = await listQuestions(db, ctx.defaultLocale, eventId);
      const input = parseManual(fd, questions, eventId, ctx.defaultLocale);
      const result = await adminCreateRegistration(db, input, { actor, confirm });
      if (!result.ok) return refusal(fd, result, null);
      if (flag(fd, 'send_confirmation')) await sendConfirmation(env, db, result.registrationId, { manageToken: result.manageToken });
      return { kind: 'ok', notice: 'created', reg: result.registrationId };
    }
    case 'bulk_preview':
    case 'bulk_send': {
      const filter = {
        statuses: fd.getAll('audience_status').filter((v): v is RegStatus => typeof v === 'string') as RegStatus[],
        ...(int(fd, 'audience_ticket') !== null ? { ticketTypeId: int(fd, 'audience_ticket')! } : {}),
      };
      if (action === 'bulk_preview') {
        return { kind: 'preview', count: (await bulkAudience(db, eventId, filter)).length, fields: fieldsOf(fd).filter(([k]) => k !== 'action') };
      }
      const queued = await queueBulkEmail(db, { eventId, actor, subject: str(fd, 'subject'), body: str(fd, 'body'), audience: filter });
      if (!queued.ok) return { kind: 'failed', code: queued.code, reg: null };
      if (queued.queued === 0) return { kind: 'failed', code: 'no_recipients', reg: null };
      const drained = await drainOutbox(env, db, { limit: DRAIN_ON_REQUEST, eventId });
      return { kind: 'ok', notice: 'bulk_queued', extra: { queued: String(queued.queued), sent: String(drained.sent) } };
    }
    case 'refund': {
      const cents = parseAmountToCents(str(fd, 'amount'));
      if (cents === null) return { kind: 'failed', code: 'invalid_amount', reg: rid };
      const result = await refundRegistration(
        env, db, { registrationId: rid!, amountCents: cents, actor, alsoCancel: flag(fd, 'also_cancel') }, { fetcher: ctx.fetcher },
      );
      return result.ok ? done('refunded') : { kind: 'failed', code: result.code, reg: rid };
    }
    case 'offline_refund': {
      const cents = parseAmountToCents(str(fd, 'amount'));
      if (cents === null) return { kind: 'failed', code: 'invalid_amount', reg: rid };
      const result = await recordOfflineRefund(db, { registrationId: rid!, amountCents: cents, actor, note: str(fd, 'note') });
      return result.ok ? done('refund_recorded') : { kind: 'failed', code: result.code, reg: rid };
    }
    case 'grant_role': {
      const personId = int(fd, 'person_id');
      const result = await grantEventRole(db, eventId, personId ?? 0, str(fd, 'role'));
      return result.ok ? { kind: 'ok', notice: 'role_granted' } : { kind: 'failed', code: result.code, reg: null };
    }
    case 'revoke_role': {
      const personId = int(fd, 'person_id');
      if (personId !== null) await revokeEventRole(db, eventId, personId);
      return { kind: 'ok', notice: 'role_revoked' };
    }
    case 'addEventAdmin':
    case 'removeEventAdmin': {
      if (!ctx.portal) return { kind: 'bad_request' };
      const personId = int(fd, 'person_id');
      if (personId !== null) {
        if (action === 'addEventAdmin') await addEventAdmin(db, eventId, personId);
        else await removeEventAdmin(db, eventId, personId);
      }
      return { kind: 'ok', notice: 'saved' };
    }
  }
  return { kind: 'bad_request' };
}

/** The form builder's JSON save, behind the same gate (registration admins only). */
export async function runBuilderSave(
  ctx: Pick<RegActionContext, 'db' | 'user' | 'eventId' | 'defaultLocale' | 'env'>,
  rawBody: string,
): Promise<{ denied: 403 | 404 } | { saved: FormSaveResponse }> {
  const role = await requireRegRole(ctx.db, ctx.user, ctx.eventId, 'manage');
  if (!role.ok) return { denied: role.status };
  if (!canEditEvent(ctx.user)) return { denied: 403 };
  return { saved: await saveFormRequest(ctx.db, ctx.eventId, rawBody, { backend: getBackend(ctx.env), defaultLocale: ctx.defaultLocale }) };
}

// ── Roster query string ──────────────────────────────────────────────────────

const STATUSES: readonly RegStatus[] = ['pending', 'review', 'confirmed', 'waitlist', 'declined', 'cancelled'];
const SORTS: readonly RosterSort[] = ['newest', 'oldest', 'name', 'status', 'confirmation'];

export interface RosterState {
  q: string;
  status: RegStatus[];
  type: number | null;
  checkedIn: boolean | null;
  /** A choice-answer filter: question id and option key (query string `ans=<id>:<option>`). */
  qid: number | null;
  opt: string;
  sort: RosterSort;
  page: number;
  view: 'registration' | 'person';
}

/** The roster filters from the page's query string; unknown or malformed values fall back to the defaults. */
export function parseRosterState(params: URLSearchParams): RosterState {
  const num = (name: string): number | null => (/^\d{1,15}$/.test(params.get(name) ?? '') ? Number(params.get(name)) : null);
  const status = (params.get('status') ?? '').split(',').filter((s): s is RegStatus => (STATUSES as readonly string[]).includes(s));
  const sort = params.get('sort') ?? '';
  const inRaw = params.get('in');
  const ans = /^(\d{1,15}):(.{1,200})$/.exec(params.get('ans') ?? '');
  return {
    q: (params.get('q') ?? '').trim().slice(0, 100),
    status: [...new Set(status)],
    type: num('type'),
    checkedIn: inRaw === 'yes' ? true : inRaw === 'no' ? false : null,
    qid: ans ? Number(ans[1]) : null,
    opt: ans ? ans[2] : '',
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as RosterSort) : 'newest',
    page: Math.max(1, num('p') ?? 1),
    view: params.get('view') === 'person' ? 'person' : 'registration',
  };
}

export function rosterOptions(state: RosterState, locale: Locale): RosterOptions {
  return {
    ...(state.q !== '' ? { q: state.q } : {}),
    ...(state.status.length > 0 ? { status: state.status } : {}),
    ...(state.type !== null ? { ticketTypeId: state.type } : {}),
    ...(state.checkedIn !== null ? { checkedIn: state.checkedIn } : {}),
    ...(state.qid !== null && state.opt !== '' ? { answer: { questionId: state.qid, option: state.opt } } : {}),
    sort: state.sort,
    page: state.page,
    view: state.view,
    locale,
  };
}

/** The query string for `state` with `changes` applied (page resets unless it is part of the change). */
export function rosterQuery(state: RosterState, changes: Partial<Record<keyof RosterState, unknown>> = {}): string {
  const next = { ...state, ...(('page' in changes) ? {} : { page: 1 }), ...changes } as RosterState;
  const p = new URLSearchParams();
  if (next.q) p.set('q', next.q);
  if (next.status.length > 0) p.set('status', next.status.join(','));
  if (next.type !== null) p.set('type', String(next.type));
  if (next.checkedIn !== null) p.set('in', next.checkedIn ? 'yes' : 'no');
  if (next.qid !== null && next.opt !== '') p.set('ans', `${next.qid}:${next.opt}`);
  if (next.sort !== 'newest') p.set('sort', next.sort);
  if (next.page > 1) p.set('p', String(next.page));
  if (next.view === 'person') p.set('view', 'person');
  return p.toString();
}

/** Every active person matching the roster filters (badges and the sign-in sheet): all pages, capped. */
export async function listAllRosterPeople(db: AppDb, eventId: number, opts: RosterOptions, cap = 5000): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  let page: RosterPage | null = null;
  for (let n = 1; rows.length < cap; n++) {
    page = await listRoster(db, eventId, { ...opts, view: 'person', page: n, pageSize: 200 });
    rows.push(...page.rows);
    if (n >= page.pages) break;
  }
  return rows.slice(0, cap);
}

/** The query-string keys a form may carry back to the page it came from (a hidden `back` field). */
export function safeBack(raw: string): string {
  const source = new URLSearchParams(raw.replace(/^\?/, ''));
  const keep = new URLSearchParams();
  // The roster's keys, and a logistics board's tab and filters (lq, ltag, ltype, lans).
  for (const key of ['q', 'status', 'type', 'in', 'ans', 'sort', 'p', 'view', 'tab', 'lq', 'ltag', 'ltype', 'lans']) {
    const value = source.get(key);
    if (value !== null && value.length <= 200) keep.set(key, value);
  }
  return keep.toString();
}
