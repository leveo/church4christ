// The registration event page's server side on BOTH backends: the access matrix (every action in the table, every
// role), cross-event refusal, the builder gate, and each action's handler behavior (validation, version conflict,
// the soft-confirm flow, approval and cancellation mail, manual add, bulk email, roles). Run against D1
// (test/regBackOfficeUi.d1.test.ts) and Postgres (test/pg/regBackOfficeUi.pg.test.ts); each mocks src/lib/email
// with test/shared/regMail so the mail the dispatcher sends can be read.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbBackend } from '../../src/lib/dbProvider';
import type { SessionUser } from '../../src/lib/types';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { grantEventRole } from '../../src/lib/regAccess';
import { listActivity } from '../../src/lib/regAdmin';
import { REG_ADMIN_ACTIONS, listAllRosterPeople, parseRosterState, rosterOptions, rosterQuery, runBuilderSave, runRegAdminAction, safeBack, type ActionOutcome, type RegActionContext } from '../../src/lib/regAdminPage';
import { activityKey, failureKey, noticeKey, reasonKey } from '../../src/lib/regAdminView';
import { CSV_BOM, registrationPeopleCsv } from '../../src/lib/regExport';
import { outboxCounts } from '../../src/lib/regOutbox';
import { mail } from './regMail';

const DAY = 24 * 3600_000;
const tsAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
let seq = 0;

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1, email: 'x@example.com', displayName: 'X', role: 'member', isAdmin: false, isEditor: false, finance: 0,
  memberTeamIds: [], leaderTeamIds: [], lang: null, isSuperAdmin: false, adminAreas: [], ...over,
});

const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) fd.append(k, value);
  return fd;
};

export function defineRegBackOfficeUiCases(label: string, getDb: () => AppDb, backend: DbBackend): void {
  const env = { DB_BACKEND: backend, APP_ORIGIN: 'https://church.example' } as RegActionContext['env'];
  const db = () => getDb();
  const ctxFor = (u: SessionUser, eventId: number, over: Partial<RegActionContext> = {}): RegActionContext => ({
    db: db(), env, user: u, eventId, portal: false, defaultLocale: 'en', ...over,
  });
  const run = (u: SessionUser, eventId: number, fields: Record<string, string | string[]>, over: Partial<RegActionContext> = {}) =>
    runRegAdminAction(ctxFor(u, eventId, over), form(fields));
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(db(), { title_en: 'Retreat', title_zh: '退修会', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 6, ...over });
  const register = async (eventId: number, name = 'Ada', over: Partial<Parameters<typeof createRegistration>[1]> = {}) => {
    const n = ++seq;
    const created = await createRegistration(db(), {
      eventId, personId: null, name, email: `${name.toLowerCase().replace(/\W+/g, '')}${n}@example.com`, status: 'confirmed', amountCents: 0,
      currency: 'usd', answers: [], attendees: [{ name }], submissionKey: `ui-${Date.now()}-${n}`, locale: 'en', ...over,
    });
    return { id: created.id, status: created.status, email: `${name.toLowerCase().replace(/\W+/g, '')}${n}@example.com` };
  };
  const person = async (name: string) => {
    const row = await db().prepare(`INSERT INTO people (display_name, email) VALUES (?1, ?2) RETURNING id`).bind(name, `${name.toLowerCase().replace(/\W+/g, '')}-${++seq}-${Date.now()}@example.com`).first<{ id: number }>();
    return row!.id;
  };
  const one = async <T>(sql: string, ...binds: unknown[]) => (await db().prepare(sql).bind(...binds).first<T>())!;
  const versionOf = async (id: number) => Number((await one<{ version: number }>(`SELECT version FROM registrations WHERE id = ?1`, id)).version);
  const statusOf = async (id: number) => (await one<{ status: string }>(`SELECT status FROM registrations WHERE id = ?1`, id)).status;
  const mailKinds = () => mail.sent.map((m) => m.kind);

  describe(`registration event page actions (${label})`, () => {
    const areaAdmin = user({ id: 9001, role: 'admin', isAdmin: true, adminAreas: ['registration'] });
    const superAdmin = user({ id: 9002, role: 'admin', isAdmin: true, isSuperAdmin: true });
    const paymentsAdmin = user({ id: 9003, role: 'admin', isAdmin: true, adminAreas: ['registration', 'payment-operations'] });
    const financeMember = user({ id: 9004, finance: 1 });

    beforeEach(async () => {
      // The staff members who act (their ids are recorded in the history, a foreign key to people).
      for (const u of [areaAdmin, superAdmin, paymentsAdmin, financeMember]) {
        await db().prepare(`INSERT INTO people (id, display_name, email) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING`).bind(u.id, `Staff ${u.id}`, `staff${u.id}@example.com`).run();
      }
      mail.sent.length = 0;
      mail.fail = false;
      mail.failTo.clear();
      mail.throwTo.clear();
      await db().prepare(`DELETE FROM email_log`).run();
    });

    // ── The access matrix ────────────────────────────────────────────────────
    describe('access matrix', () => {
      /** A harmless request for each action: it passes the gate for anyone allowed, and may refuse on content. */
      const request = (action: string, registrationId: number, attendeeId: number): Record<string, string> => ({
        action, registration_id: String(registrationId), ...(attendeeId ? { attendee_id: String(attendeeId) } : {}), version: '1',
        decision: 'accept', to: 'waitlist', person_id: '1', role: 'viewer', note: 'x', name: 'N', amount: '1.00', subject: 's', body: 'b',
        contact_name: 'Ada', contact_email: 'ada@example.com',
      });
      const attendeeOf = async (registrationId: number) => Number((await one<{ id: number }>(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY id`, registrationId)).id);

      it('lists every action with a known need, and nothing is open to a plain viewer', () => {
        const needs = new Set(Object.values(REG_ADMIN_ACTIONS).map((a) => a.need));
        expect([...needs].sort()).toEqual(['edit', 'manage', 'refund']);
        for (const name of ['edit', 'cancel', 'decide', 'create', 'bulk_send', 'refund', 'grant_role', 'addEventAdmin']) expect(REG_ADMIN_ACTIONS[name], name).toBeDefined();
      });

      it('a person with no role, a desk-only volunteer and a viewer are refused on EVERY action, and nothing changes', async () => {
        const eventId = await newEvent();
        const reg = await register(eventId);
        const att = await attendeeOf(reg.id);
        const stranger = user({ id: await person('Stranger') });
        const desk = user({ id: await person('Desk') });
        const viewer = user({ id: await person('Viewer') });
        await grantEventRole(db(), eventId, desk.id, 'desk');
        await grantEventRole(db(), eventId, viewer.id, 'viewer');
        const before = await versionOf(reg.id);
        for (const action of Object.keys(REG_ADMIN_ACTIONS)) {
          for (const [who, u] of [['stranger', stranger], ['desk', desk], ['viewer', viewer]] as const) {
            expect(await run(u, eventId, request(action, reg.id, att)), `${who} ${action}`).toEqual({ kind: 'denied', status: 403 });
          }
        }
        expect(await versionOf(reg.id)).toBe(before);
        expect(await statusOf(reg.id)).toBe('confirmed');
        expect(mail.sent).toHaveLength(0);
        // An unknown action is refused at the gate too (the strongest ordinary need), not answered with a 400.
        expect(await run(viewer, eventId, { action: 'nope' })).toEqual({ kind: 'denied', status: 403 });
        expect(await run(areaAdmin, eventId, { action: 'nope' })).toEqual({ kind: 'bad_request' });
      });

      it('a per-event registrar manages registrations but cannot touch settings, roles, event admins or refunds', async () => {
        const eventId = await newEvent();
        const registrar = user({ id: await person('Registrar') });
        await grantEventRole(db(), eventId, registrar.id, 'registrar');
        for (const action of Object.keys(REG_ADMIN_ACTIONS)) {
          const need = REG_ADMIN_ACTIONS[action].need;
          const reg = await register(eventId);
          const outcome = await run(registrar, eventId, request(action, reg.id, await attendeeOf(reg.id)), { portal: true, logistics: true });
          if (need === 'manage') expect(outcome.kind, action).not.toBe('denied');
          else expect(outcome, action).toEqual({ kind: 'denied', status: 403 });
        }
        // Granting a role was refused: the table holds only the (unrelated) rows from before.
        expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_event_access WHERE event_id = ?1`, eventId)).n)).toBe(1);
      });

      it('refunds need the payment-operations permission AND manage: area admin and per-event registrar are refused, the permitted pass the gate', async () => {
        const eventId = await newEvent();
        const reg = await register(eventId);
        const registrar = user({ id: await person('R2') });
        await grantEventRole(db(), eventId, registrar.id, 'registrar');
        for (const action of ['refund', 'offline_refund']) {
          expect(await run(areaAdmin, eventId, request(action, reg.id, 0)), `area ${action}`).toEqual({ kind: 'denied', status: 403 });
          expect(await run(registrar, eventId, request(action, reg.id, 0)), `registrar ${action}`).toEqual({ kind: 'denied', status: 403 });
          // A finance-flagged member with only a per-event registrar role can refund (canRefund) and manage.
          const finRegistrar = { ...registrar, finance: 1 };
          expect((await run(finRegistrar, eventId, request(action, reg.id, 0))).kind, `finance registrar ${action}`).not.toBe('denied');
          // A finance member without any role on the event is refused (manage fails first).
          expect(await run(financeMember, eventId, request(action, reg.id, 0)), `finance ${action}`).toEqual({ kind: 'denied', status: 403 });
          expect((await run(paymentsAdmin, eventId, request(action, reg.id, 0))).kind, `payments ${action}`).not.toBe('denied');
        }
        // Card refunds depend on the backend and Stripe: D1 (or no Stripe) answers "unavailable", never a Stripe call.
        expect(await run(superAdmin, eventId, { action: 'refund', registration_id: String(reg.id), amount: '5.00' })).toEqual({ kind: 'failed', code: 'unavailable', reg: reg.id });
      });

      it('refuses a registration or person of ANOTHER event (404), whoever asks', async () => {
        const mine = await newEvent();
        const other = await newEvent();
        const foreign = await register(other, 'Foreign');
        const own = await register(mine, 'Own');
        const foreignAtt = await attendeeOf(foreign.id);
        const registrar = user({ id: await person('R3') });
        await grantEventRole(db(), mine, registrar.id, 'registrar');
        for (const u of [areaAdmin, registrar]) {
          for (const action of ['edit', 'cancel', 'decide', 'note', 'move', 'resend', 'add_person']) {
            expect(await run(u, mine, request(action, foreign.id, 0)), `${action} foreign registration`).toEqual({ kind: 'denied', status: 404 });
          }
          // Own registration but another event's person.
          expect(await run(u, mine, request('change_ticket', own.id, foreignAtt))).toEqual({ kind: 'denied', status: 404 });
          expect(await run(u, mine, request('remove_person', own.id, foreignAtt))).toEqual({ kind: 'denied', status: 404 });
          // A client-supplied event id is ignored: the page's event decides.
          expect(await run(u, mine, { ...request('cancel', foreign.id, 0), event_id: String(other) })).toEqual({ kind: 'denied', status: 404 });
        }
        expect(await statusOf(foreign.id)).toBe('confirmed');
        // A role on another event gives nothing on this one.
        const stranger = user({ id: await person('R4') });
        await grantEventRole(db(), other, stranger.id, 'registrar');
        expect(await run(stranger, mine, request('cancel', own.id, 0))).toEqual({ kind: 'denied', status: 403 });
      });

      it('the form builder save is for registration admins only', async () => {
        const eventId = await newEvent();
        const payload = JSON.stringify({ questions: [], tickets: [] });
        const registrar = user({ id: await person('R5') });
        const viewer = user({ id: await person('V5') });
        const desk = user({ id: await person('D5') });
        await grantEventRole(db(), eventId, registrar.id, 'registrar');
        await grantEventRole(db(), eventId, viewer.id, 'viewer');
        await grantEventRole(db(), eventId, desk.id, 'desk');
        const ctx = (u: SessionUser) => ({ db: db(), user: u, eventId, defaultLocale: 'en' as const, env: env });
        expect(await runBuilderSave(ctx(registrar), payload)).toEqual({ denied: 403 });
        expect(await runBuilderSave(ctx(viewer), payload)).toEqual({ denied: 403 });
        expect(await runBuilderSave(ctx(desk), payload)).toEqual({ denied: 403 });
        expect(await runBuilderSave(ctx(user({ id: await person('Nobody') })), payload)).toEqual({ denied: 403 });
        const saved = await runBuilderSave(ctx(areaAdmin), payload);
        expect('saved' in saved && saved.saved.status).toBe(200);
        expect(await runBuilderSave({ ...ctx(areaAdmin), eventId: 99999999 }, payload)).toEqual({ denied: 404 });
      });

      it('grants and revokes per-event roles only for registration admins, validated', async () => {
        const eventId = await newEvent();
        const helper = await person('Helper');
        expect(await run(areaAdmin, eventId, { action: 'grant_role', person_id: String(helper), role: 'desk' })).toEqual({ kind: 'ok', notice: 'role_granted' });
        expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_event_access WHERE event_id = ?1 AND person_id = ?2 AND role = 'desk'`, eventId, helper)).n)).toBe(1);
        expect(await run(areaAdmin, eventId, { action: 'grant_role', person_id: String(helper), role: 'owner' })).toEqual({ kind: 'failed', code: 'invalid_role', reg: null });
        expect(await run(areaAdmin, eventId, { action: 'grant_role', person_id: '99999999', role: 'viewer' })).toEqual({ kind: 'failed', code: 'person_not_found', reg: null });
        expect(await run(areaAdmin, eventId, { action: 'revoke_role', person_id: String(helper) })).toEqual({ kind: 'ok', notice: 'role_revoked' });
        expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_event_access WHERE event_id = ?1`, eventId)).n)).toBe(0);
        // Event admins exist only with the portal module.
        expect(await run(areaAdmin, eventId, { action: 'addEventAdmin', person_id: String(helper) })).toEqual({ kind: 'bad_request' });
      });
    });

    // ── Each action ──────────────────────────────────────────────────────────
    describe('edit, notes, people and tickets', () => {
      it('edits contact, a person and answers (staff may skip required); a stale version answers conflict and changes nothing', async () => {
        const eventId = await newEvent();
        const reg = await register(eventId, 'Ada');
        const q = await (async () => {
          const { saveEventForm } = await import('../../src/lib/regDb');
          expect(await saveEventForm(db(), eventId, { questions: [{ type: 'text', required: true, labels: { en: 'Church' } }] }, { backend })).toEqual({ ok: true });
          return Number((await one<{ id: number }>(`SELECT id FROM reg_questions WHERE event_id = ?1`, eventId)).id);
        })();
        const attId = Number((await one<{ id: number }>(`SELECT id FROM reg_attendees WHERE registration_id = ?1`, reg.id)).id);
        const v = await versionOf(reg.id);
        const ok = await run(areaAdmin, eventId, {
          action: 'edit', registration_id: String(reg.id), version: String(v),
          contact_name: 'Ada Lovelace', contact_email: 'ADA@Example.com', contact_phone: '555 0100',
          [`att_${attId}_name`]: 'Ada L.', reg_answers: '1', [`q_${q}`]: '',
        });
        expect(ok).toEqual({ kind: 'ok', notice: 'saved', reg: reg.id });
        const row = await one<{ name: string; email: string; phone: string }>(`SELECT name, email, phone FROM registrations WHERE id = ?1`, reg.id);
        expect(row).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', phone: '555 0100' });
        expect(await versionOf(reg.id)).toBe(v + 1);
        expect((await listActivity(db(), reg.id)).map((a) => a.action)).toContain('edit');

        // Stale: the form was read at v, the registration is now v + 1.
        const stale = await run(areaAdmin, eventId, { action: 'edit', registration_id: String(reg.id), version: String(v), contact_name: 'Someone Else' });
        expect(stale).toEqual({ kind: 'conflict', reg: reg.id });
        expect((await one<{ name: string }>(`SELECT name FROM registrations WHERE id = ?1`, reg.id)).name).toBe('Ada Lovelace');

        // Validation: a bad address comes back by field path, and nothing is written.
        const bad = await run(areaAdmin, eventId, { action: 'edit', registration_id: String(reg.id), version: String(v + 1), contact_email: 'not-an-email' });
        expect(bad).toMatchObject({ kind: 'invalid', errors: [{ path: 'contact.email', code: 'invalid' }] });
        expect(await versionOf(reg.id)).toBe(v + 1);
        // A missing version is a refusal, not a write.
        expect(await run(areaAdmin, eventId, { action: 'edit', registration_id: String(reg.id), contact_name: 'X' })).toEqual({ kind: 'failed', code: 'invalid', reg: reg.id });
      });

      it('saves the staff note and clears it with a blank one', async () => {
        const eventId = await newEvent();
        const reg = await register(eventId);
        const v = await versionOf(reg.id);
        expect(await run(areaAdmin, eventId, { action: 'note', registration_id: String(reg.id), version: String(v), note: 'Allergic to nuts' })).toMatchObject({ kind: 'ok', notice: 'saved' });
        expect((await one<{ admin_note: string | null }>(`SELECT admin_note FROM registrations WHERE id = ?1`, reg.id)).admin_note).toBe('Allergic to nuts');
        expect(await run(areaAdmin, eventId, { action: 'note', registration_id: String(reg.id), version: String(v + 1), note: '   ' })).toMatchObject({ kind: 'ok' });
        expect((await one<{ admin_note: string | null }>(`SELECT admin_note FROM registrations WHERE id = ?1`, reg.id)).admin_note).toBeNull();
      });

      it('adds and removes a person; the last person leaving cancels the registration and mails the registrant', async () => {
        const eventId = await newEvent();
        const reg = await register(eventId, 'Ada');
        let v = await versionOf(reg.id);
        expect(await run(areaAdmin, eventId, { action: 'add_person', registration_id: String(reg.id), version: String(v), name: 'Bob' })).toMatchObject({ kind: 'ok', notice: 'person_added' });
        v += 1;
        const people = (await db().prepare(`SELECT id, name FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(reg.id).all<{ id: number; name: string }>()).results;
        expect(people.map((p) => p.name)).toEqual(['Ada', 'Bob']);
        expect(await run(areaAdmin, eventId, { action: 'remove_person', registration_id: String(reg.id), version: String(v), attendee_id: String(people[1].id) })).toMatchObject({ kind: 'ok', notice: 'person_removed' });
        v += 1;
        expect(mailKinds()).toEqual(['regCancelled']); // the registration goes on: "Bob can't come"
        mail.sent.length = 0;
        expect(await run(areaAdmin, eventId, { action: 'remove_person', registration_id: String(reg.id), version: String(v), attendee_id: String(people[0].id) })).toMatchObject({ kind: 'ok' });
        expect(await statusOf(reg.id)).toBe('cancelled');
        expect(mailKinds()).toEqual(['regCancelled']);
      });

      it('changes a ticket type and asks first when the type is full (soft confirm), then does it anyway', async () => {
        const eventId = await newEvent();
        const { saveEventForm } = await import('../../src/lib/regDb');
        expect(await saveEventForm(db(), eventId, { tickets: [{ labels: { en: 'Adult' }, price_cents: 0, capacity: 1 }, { labels: { en: 'Child' }, price_cents: 0 }] }, { backend })).toEqual({ ok: true });
        const [adult, child] = (await db().prepare(`SELECT id FROM reg_ticket_types WHERE event_id = ?1 ORDER BY sort, id`).bind(eventId).all<{ id: number }>()).results.map((r) => Number(r.id));
        const first = await register(eventId, 'First', { attendees: [{ name: 'First', ticketTypeId: adult }] });
        const second = await register(eventId, 'Second', { attendees: [{ name: 'Second', ticketTypeId: child }] });
        expect(first.status).toBe('confirmed');
        const att = Number((await one<{ id: number }>(`SELECT id FROM reg_attendees WHERE registration_id = ?1`, second.id)).id);
        const fields = { action: 'change_ticket', registration_id: String(second.id), version: String(await versionOf(second.id)), attendee_id: String(att), ticket_type_id: String(adult) };
        const asked = await run(areaAdmin, eventId, fields);
        expect(asked).toMatchObject({ kind: 'confirm', reason: 'ticket_type_full', reg: second.id });
        const replay = (asked as Extract<ActionOutcome, { kind: 'confirm' }>).fields;
        expect(replay.some(([k]) => k === 'confirm')).toBe(false);
        expect(Object.fromEntries(replay)).toMatchObject({ action: 'change_ticket', registration_id: String(second.id), ticket_type_id: String(adult) });
        // Nothing changed yet; the "Do it anyway" form replays the fields with confirm=1.
        expect((await one<{ ticket_type_id: number }>(`SELECT ticket_type_id FROM reg_attendees WHERE id = ?1`, att)).ticket_type_id).toBe(child);
        expect(await run(areaAdmin, eventId, { ...fields, confirm: '1' })).toMatchObject({ kind: 'ok', notice: 'saved' });
        expect(Number((await one<{ ticket_type_id: number }>(`SELECT ticket_type_id FROM reg_attendees WHERE id = ?1`, att)).ticket_type_id)).toBe(adult);
      });
    });

    describe('approval, moves, cancel and resend', () => {
      it('accept / waitlist / decline an approval sign-up: status, activity and the decision mail (QR only when accepted)', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const a = await register(eventId, 'Ada');
        const b = await register(eventId, 'Bea');
        const c = await register(eventId, 'Cy');
        expect([a.status, b.status, c.status]).toEqual(['review', 'review', 'review']);

        expect(await run(areaAdmin, eventId, { action: 'decide', registration_id: String(a.id), decision: 'accept', version: String(await versionOf(a.id)) })).toEqual({ kind: 'ok', notice: 'decided_accept', reg: a.id });
        expect(await statusOf(a.id)).toBe('confirmed');
        const accepted = mail.sent.find((m) => m.to === a.email)!;
        expect(accepted.kind).toBe('regDecision');
        expect(accepted.html).toContain('/register/qr/');

        mail.sent.length = 0;
        expect(await run(areaAdmin, eventId, { action: 'decide', registration_id: String(b.id), decision: 'waitlist' })).toMatchObject({ kind: 'ok', notice: 'decided_waitlist' });
        expect(await statusOf(b.id)).toBe('waitlist');
        expect(mail.sent.find((m) => m.to === b.email)!.kind).toBe('regDecision');

        mail.sent.length = 0;
        expect(await run(areaAdmin, eventId, { action: 'decide', registration_id: String(c.id), decision: 'decline' })).toMatchObject({ kind: 'ok', notice: 'decided_decline' });
        expect(await statusOf(c.id)).toBe('declined');
        const declined = mail.sent.find((m) => m.to === c.email)!;
        expect(declined.kind).toBe('regDecision');
        expect(declined.html).not.toContain('/register/qr/');
        expect((await listActivity(db(), c.id)).map((x) => x.action)).toContain('declined');
        expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM registrations WHERE id = ?1 AND decided_by IS NOT NULL`, c.id)).n)).toBe(1);
        // A decision that changes nothing (already declined) is refused.
        expect(await run(areaAdmin, eventId, { action: 'decide', registration_id: String(c.id), decision: 'decline' })).toEqual({ kind: 'failed', code: 'not_editable', reg: c.id });
        expect(await run(areaAdmin, eventId, { action: 'decide', registration_id: String(c.id), decision: 'maybe' })).toEqual({ kind: 'bad_request' });
      });

      it('accepting a waitlisted sign-up into a full event asks first, shows the reason and goes ahead with confirm', async () => {
        const eventId = await newEvent({ requires_approval: 1, capacity: 1 });
        const a = await register(eventId, 'Ada'); // review, holds the one seat
        const b = await register(eventId, 'Bea', { status: 'waitlist' as 'confirmed' });
        expect(a.status).toBe('review');
        const fields = { action: 'decide', registration_id: String(b.id), decision: 'accept', version: String(await versionOf(b.id)) };
        const asked = await run(areaAdmin, eventId, fields);
        expect(asked).toMatchObject({ kind: 'confirm', reason: 'event_full' });
        expect(await statusOf(b.id)).toBe('waitlist');
        expect(await run(areaAdmin, eventId, { ...fields, confirm: '1' })).toMatchObject({ kind: 'ok', notice: 'decided_accept' });
        expect(await statusOf(b.id)).toBe('confirmed');
      });

      it('cancel frees the seat: the waitlisted registration is promoted and both are mailed (version optional for the roster button)', async () => {
        const eventId = await newEvent({ capacity: 1 });
        const a = await register(eventId, 'Ada');
        const b = await register(eventId, 'Bea', { status: 'waitlist' as 'confirmed' });
        expect(await run(areaAdmin, eventId, { action: 'cancel', registration_id: String(a.id) })).toEqual({ kind: 'ok', notice: 'cancelled', reg: a.id });
        expect(await statusOf(a.id)).toBe('cancelled');
        expect(await statusOf(b.id)).toBe('confirmed');
        expect(mail.sent.map((m) => [m.kind, m.to])).toEqual([['regCancelled', a.email], ['regPromoted', b.email]]);
        // A stale version on the drawer's cancel answers conflict.
        const c = await register(eventId, 'Cy');
        expect(await run(areaAdmin, eventId, { action: 'cancel', registration_id: String(c.id), version: '999' })).toEqual({ kind: 'conflict', reg: c.id });
        expect(await statusOf(c.id)).not.toBe('cancelled');
      });

      it('moves a free registration between the waitlist and confirmed, asking before it goes over the limit', async () => {
        const eventId = await newEvent({ capacity: 1 });
        const a = await register(eventId, 'Ada');
        const b = await register(eventId, 'Bea', { status: 'waitlist' as 'confirmed' });
        const fields = { action: 'move', registration_id: String(b.id), to: 'confirmed', version: String(await versionOf(b.id)) };
        expect(await run(areaAdmin, eventId, fields)).toMatchObject({ kind: 'confirm', reason: 'event_full' });
        expect(await run(areaAdmin, eventId, { ...fields, confirm: '1' })).toMatchObject({ kind: 'ok', notice: 'moved' });
        expect(await statusOf(b.id)).toBe('confirmed');
        expect(await run(areaAdmin, eventId, { action: 'move', registration_id: String(a.id), to: 'cancelled', version: '1' })).toEqual({ kind: 'bad_request' });
      });

      it('resends the confirmation (mail) and records it in the history; a cancelled registration cannot be resent', async () => {
        const eventId = await newEvent();
        const a = await register(eventId, 'Ada');
        expect(await run(areaAdmin, eventId, { action: 'resend', registration_id: String(a.id) })).toEqual({ kind: 'ok', notice: 'resent', reg: a.id });
        expect(mail.sent.map((m) => [m.kind, m.to])).toEqual([['regConfirm', a.email]]);
        expect((await listActivity(db(), a.id)).map((x) => x.action)).toContain('resent');
        await run(areaAdmin, eventId, { action: 'cancel', registration_id: String(a.id) });
        mail.sent.length = 0;
        expect(await run(areaAdmin, eventId, { action: 'resend', registration_id: String(a.id) })).toEqual({ kind: 'failed', code: 'resend_failed', reg: a.id });
        expect(mail.sent).toHaveLength(0);
      });
    });

    describe('manual add, bulk email, offline refunds', () => {
      it('adds a walk-in on a free event: confirmed, with people and the optional confirmation mail', async () => {
        const eventId = await newEvent();
        const out = await run(areaAdmin, eventId, {
          action: 'create', contact_name: 'Walk In', contact_email: 'Walk@Example.com', contact_phone: '555 0100',
          p0_name: '', p1_name: 'Plus One', send_confirmation: '1',
        });
        expect(out).toMatchObject({ kind: 'ok', notice: 'created' });
        const id = (out as { reg: number }).reg;
        const row = await one<{ status: string; email: string; party_size: number }>(`SELECT status, email, party_size FROM registrations WHERE id = ?1`, id);
        expect(row).toMatchObject({ status: 'confirmed', email: 'walk@example.com', party_size: 2 });
        expect((await db().prepare(`SELECT name FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(id).all<{ name: string }>()).results.map((r) => r.name)).toEqual(['Walk In', 'Plus One']);
        expect(mail.sent.map((m) => [m.kind, m.to])).toEqual([['regConfirm', 'walk@example.com']]);
        expect((await listActivity(db(), id)).map((a) => a.action)).toEqual(['created']);

        // Without the checkbox nothing is mailed; a bad address is refused by field path.
        mail.sent.length = 0;
        expect(await run(areaAdmin, eventId, { action: 'create', contact_name: 'Quiet', contact_email: 'quiet@example.com' })).toMatchObject({ kind: 'ok' });
        expect(mail.sent).toHaveLength(0);
        expect(await run(areaAdmin, eventId, { action: 'create', contact_name: 'Bad', contact_email: 'nope' })).toMatchObject({ kind: 'invalid', errors: [{ path: 'contact.email' }] });
      });

      it('a party over the event limit asks first; on a paid event it needs offline or complimentary, never a card', async () => {
        const full = await newEvent({ capacity: 1 });
        await register(full, 'Seat');
        const fields = { action: 'create', contact_name: 'Late', contact_email: 'late@example.com' };
        expect(await run(areaAdmin, full, fields)).toMatchObject({ kind: 'confirm', reason: 'event_full' });
        expect(await run(areaAdmin, full, { ...fields, confirm: '1' })).toMatchObject({ kind: 'ok' });

        if (backend === 'supabase') {
          const paid = await newEvent({ price_cents: 2500 });
          const base = { action: 'create', contact_name: 'Cash', contact_email: 'cash@example.com' };
          expect(await run(areaAdmin, paid, base)).toEqual({ kind: 'failed', code: 'payment_method_required', reg: null });
          const offline = await run(areaAdmin, paid, { ...base, payment_method: 'offline', amount: '20.00' });
          expect(offline).toMatchObject({ kind: 'ok' });
          const row = await one<{ amount_cents: number; payment_method: string }>(`SELECT amount_cents, payment_method FROM registrations WHERE id = ?1`, (offline as { reg: number }).reg);
          expect(row).toMatchObject({ amount_cents: 2000, payment_method: 'offline' });
          const comp = await run(areaAdmin, paid, { ...base, contact_email: 'comp@example.com', payment_method: 'comp' });
          expect((await one<{ payment_method: string; amount_cents: number }>(`SELECT payment_method, amount_cents FROM registrations WHERE id = ?1`, (comp as { reg: number }).reg))).toMatchObject({ payment_method: 'comp', amount_cents: 0 });
        }
      });

      it('previews the recipient count, then queues and drains the first rows; counts by outbox status', async () => {
        const eventId = await newEvent();
        const people = [await register(eventId, 'Ada'), await register(eventId, 'Bea'), await register(eventId, 'Cy', { status: 'waitlist' as 'confirmed' })];
        const base = { subject: 'Hello {name}', body: 'See you at {event}.' };
        const preview = await run(areaAdmin, eventId, { action: 'bulk_preview', audience_status: ['confirmed'], ...base });
        expect(preview).toMatchObject({ kind: 'preview', count: 2 });
        expect(Object.fromEntries((preview as Extract<ActionOutcome, { kind: 'preview' }>).fields)).toMatchObject({ subject: 'Hello {name}', audience_status: 'confirmed' });
        expect((await run(areaAdmin, eventId, { action: 'bulk_preview', audience_status: ['confirmed', 'waitlist'], ...base }))).toMatchObject({ count: 3 });
        expect(mail.sent).toHaveLength(0); // a preview never sends

        const sent = await run(areaAdmin, eventId, { action: 'bulk_send', audience_status: ['confirmed'], ...base });
        expect(sent).toEqual({ kind: 'ok', notice: 'bulk_queued', extra: { queued: '2', sent: '2' } });
        expect(mail.sent.map((m) => m.to).sort()).toEqual([people[0].email, people[1].email].sort());
        expect(mail.sent[0].kind).toBe('regBulk');
        expect(mail.sent.find((m) => m.to === people[0].email)!.text).toContain('See you at Retreat.');
        expect(await outboxCounts(db(), eventId)).toEqual({ queued: 0, sent: 2, failed: 0, skipped: 0 });

        // Nobody in the audience, or no subject: refused, nothing queued.
        expect(await run(areaAdmin, eventId, { action: 'bulk_send', audience_status: ['declined'], ...base })).toEqual({ kind: 'failed', code: 'no_recipients', reg: null });
        expect(await run(areaAdmin, eventId, { action: 'bulk_send', audience_status: ['confirmed'], subject: '', body: 'x' })).toEqual({ kind: 'failed', code: 'invalid', reg: null });
      });

      it('records an offline refund on an offline payment (no money moves) and refuses it on a card payment', async () => {
        if (backend !== 'supabase') return; // paid registrations exist on Postgres only
        const eventId = await newEvent({ price_cents: 3000 });
        const offline = await register(eventId, 'Cash', { amountCents: 3000 });
        await db().prepare(`UPDATE registrations SET payment_method = 'offline' WHERE id = ?1`).bind(offline.id).run();
        const out = await run(paymentsAdmin, eventId, { action: 'offline_refund', registration_id: String(offline.id), amount: '10.00', note: 'Cash handed back' });
        expect(out).toEqual({ kind: 'ok', notice: 'refund_recorded', reg: offline.id });
        expect(Number((await one<{ refunded_cents: number }>(`SELECT refunded_cents FROM registrations WHERE id = ?1`, offline.id)).refunded_cents)).toBe(1000);
        expect(await run(paymentsAdmin, eventId, { action: 'offline_refund', registration_id: String(offline.id), amount: '99.00' })).toEqual({ kind: 'failed', code: 'exceeds_paid', reg: offline.id });
        expect(await run(paymentsAdmin, eventId, { action: 'offline_refund', registration_id: String(offline.id), amount: 'abc' })).toEqual({ kind: 'failed', code: 'invalid_amount', reg: offline.id });
        const card = await register(eventId, 'Card', { amountCents: 3000 });
        await db().prepare(`UPDATE registrations SET payment_method = 'stripe' WHERE id = ?1`).bind(card.id).run();
        expect(await run(paymentsAdmin, eventId, { action: 'offline_refund', registration_id: String(card.id), amount: '5.00' })).toMatchObject({ kind: 'failed' });
      });
    });

    // ── Roster query string, print data, people CSV ──────────────────────────
    describe('roster query, print data and exports', () => {
      it('parses and rebuilds the roster query string, ignoring junk', () => {
        const state = parseRosterState(new URLSearchParams('q=%20ada%20&status=confirmed,nope,waitlist&type=7&in=no&ans=12:red&sort=name&p=3&view=person'));
        expect(state).toEqual({ q: 'ada', status: ['confirmed', 'waitlist'], type: 7, checkedIn: false, qid: 12, opt: 'red', sort: 'name', page: 3, view: 'person' });
        expect(rosterQuery(state)).toBe('q=ada&status=confirmed%2Cwaitlist&type=7&in=no&ans=12%3Ared&sort=name&view=person'); // page resets on a filter change
        expect(rosterQuery(state, { page: 3 })).toContain('p=3');
        expect(rosterOptions(state, 'en')).toMatchObject({ q: 'ada', status: ['confirmed', 'waitlist'], ticketTypeId: 7, checkedIn: false, answer: { questionId: 12, option: 'red' }, sort: 'name', page: 3, view: 'person' });
        expect(parseRosterState(new URLSearchParams('status=zzz&sort=bogus&p=-4&in=maybe&ans=x'))).toMatchObject({ status: [], sort: 'newest', page: 1, checkedIn: null, qid: null });
        expect(safeBack('q=x&evil=1&status=review&p=2&reg=5')).toBe('q=x&status=review&p=2');
      });

      it('lists every active person for badges and the sign-in sheet, filtered by status', async () => {
        const eventId = await newEvent();
        await register(eventId, 'Ada', { attendees: [{ name: 'Ada' }, { name: 'Bob' }] });
        const c = await register(eventId, 'Cy', { status: 'waitlist' as 'confirmed' });
        const all = await listAllRosterPeople(db(), eventId, { sort: 'name' });
        expect(all.map((r) => r.people[0].name)).toEqual(['Ada', 'Bob', 'Cy']);
        const confirmed = await listAllRosterPeople(db(), eventId, { status: ['confirmed'], sort: 'name' });
        expect(confirmed.map((r) => r.people[0].name)).toEqual(['Ada', 'Bob']);
        expect(c.status).toBe('waitlist');
      });

      it('exports one row per person, neutralizing formulas, with the BOM kept for the route', async () => {
        const eventId = await newEvent();
        await register(eventId, 'Ada', { attendees: [{ name: 'Ada' }, { name: '=SUM(A1)' }], phone: '555 0100' });
        const csv = await registrationPeopleCsv(db(), 'en', eventId);
        const [header, ...lines] = csv.split('\r\n');
        expect(header).toBe('Confirmation,Person,Ticket type,Status,Contact name,Email,Phone,Checked in,Registered');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(',Ada,');
        expect(lines[1]).toContain(",'=SUM(A1),");
        expect(lines[0]).toContain(',confirmed,Ada,');
        expect(lines[0]).toContain(',no,');
        expect(csv.startsWith(CSV_BOM)).toBe(false);
        expect(CSV_BOM).toBe('﻿');
      });

      it('names every history action and refusal with a dictionary key', () => {
        expect(activityKey('accepted')).toBe('admin.reg.act.accepted');
        expect(activityKey('something_new')).toBe('admin.reg.act.other');
        expect(noticeKey('saved')).toBe('admin.reg.bo.n.saved');
        expect(noticeKey('<script>')).toBeNull();
        expect(failureKey('exceeds_paid')).toBe('admin.reg.bo.e.exceedsPaid');
        expect(failureKey('???')).toBe('register.manage.failed');
        expect(reasonKey('event_full')).toBe('admin.reg.bo.confirmEventFull');
        expect(reasonKey('weird')).toBe('admin.reg.bo.confirmCapacity');
      });
    });
  });
}
