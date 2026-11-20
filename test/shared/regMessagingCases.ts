// Registration messaging that must hold on BOTH backends: the approval-event emails (received, decisions,
// promotion into review), the reminder sweep, bulk email (queue, drain, cron drain) and refund bookkeeping that
// does not need Stripe. Run against D1 (test/regMessaging.d1.test.ts) and Postgres (test/pg/regMessaging.pg.test.ts);
// each file mocks src/lib/email with test/shared/regMail.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { decideRegistration } from '../../src/lib/regAdmin';
import { findRegistrationByToken } from '../../src/lib/regManage';
import { sendConfirmation, sendDecision, sweepReminders, type RegNotifyEnv } from '../../src/lib/regNotify';
import { CRON_DRAIN_LIMIT, DRAIN_ON_REQUEST, drainOutbox, queueBulkEmail, sweepOutbox } from '../../src/lib/regMessaging';
import { claimReminder, outboxCounts } from '../../src/lib/regOutbox';
import { clearModuleCache } from '../../src/lib/modules';
import { setSetting } from '../../src/lib/settings';
import { recordOfflineRefund, refundRegistration } from '../../src/lib/regRefunds';
import { mail } from './regMail';
import { ts } from './regCoreCases';

const DAY = 24 * 3600_000;
let seq = 0;

export function defineRegMessagingCases(label: string, getDb: () => AppDb, backend: 'd1' | 'supabase'): void {
  const env: RegNotifyEnv & { DB_BACKEND: string } = { DB_BACKEND: backend, APP_ORIGIN: 'https://church.example' };
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(getDb(), { title_en: 'Fall <Retreat> & Picnic', title_zh: '秋季退修会', starts_at: ts(30 * DAY), ends_at: ts(30 * DAY + 2 * 3600_000), location: 'Hall A', active: 1, max_party_size: 4, ...over });
  const register = async (eventId: number, over: Partial<Parameters<typeof createRegistration>[1]> = {}) => {
    const n = ++seq;
    const email = `ada${n}-${Date.now()}@example.com`;
    const created = await createRegistration(getDb(), {
      eventId, personId: null, name: `Ada ${n}`, email, status: 'confirmed', amountCents: 0,
      currency: 'usd', answers: [], submissionKey: `msg-${Date.now()}-${n}`, locale: 'en', ...over,
    });
    return { ...created, email: over.email ?? email };
  };
  const row = (id: number) =>
    getDb().prepare(`SELECT confirmation_sent_at, reminder_sent_at, manage_token_hash, status FROM registrations WHERE id = ?1`).bind(id)
      .first<{ confirmation_sent_at: string | null; reminder_sent_at: string | null; manage_token_hash: string | null; status: string }>();
  const tokenIn = (html: string): string => /#t=([A-Za-z0-9_-]{43})/.exec(html)?.[1] ?? '';
  const mailTo = (email: string) => mail.sent.filter((m) => m.to === email);

  describe(`registration messaging (${label})`, () => {
    beforeEach(async () => {
      mail.sent.length = 0;
      mail.fail = false;
      mail.failTo.clear();
      mail.throwTo.clear();
      await getDb().prepare(`DELETE FROM email_log`).run();
    });

    // ── Approval events ──────────────────────────────────────────────────────
    describe('approval emails', () => {
      it('mails a new sign-up "received, waiting for approval": no QR, no calendar, never "confirmed"', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const created = await register(eventId, { name: 'Ada <b>L</b>' });
        expect(created.status).toBe('review');
        expect(await sendConfirmation(env, getDb(), created.id, { manageToken: created.manageToken })).toBe(true);
        const [m] = mail.sent;
        expect(m.kind).toBe('regConfirm');
        expect(m.subject).toBe('We received your registration: Fall <Retreat> & Picnic');
        expect(m.html).toContain('waiting for approval');
        expect(m.html).toContain('Waiting for approval'); // the status line
        expect(m.html).not.toMatch(/Confirmed|You’re registered|<img/);
        expect(m.text).not.toMatch(/Confirmed|You’re registered/);
        expect(m.text).not.toContain('/register/qr/');
        expect(m.attachments).toHaveLength(0);
        expect(tokenIn(m.html)).toBe(created.manageToken); // the manage link is there, so the registrant can follow up
        expect((await row(created.id))!.confirmation_sent_at).not.toBeNull();
      });

      it('accept: the confirmation with QR and calendar, and a rotated link (rolled back when the send fails)', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const created = await register(eventId);
        const decided = await decideRegistration(getDb(), created.id, 'accept', null);
        expect(decided).toMatchObject({ ok: true, decision: 'accept', status: 'confirmed' });
        if (!decided.ok) return;

        mail.fail = true;
        expect(await sendDecision(env, getDb(), decided)).toBe(false);
        expect((await findRegistrationByToken(getDb(), created.manageToken))?.id).toBe(created.id); // nothing lost to the failed send

        mail.fail = false;
        mail.sent.length = 0;
        expect(await sendDecision(env, getDb(), decided)).toBe(true);
        const [m] = mail.sent;
        expect(m).toMatchObject({ kind: 'regDecision', redactDevLogBody: true });
        expect(m.subject).toBe('Your registration is approved: Fall <Retreat> & Picnic');
        expect(m.html).toContain('Confirmed');
        expect(m.html).toContain(`/register/qr/${eventId}/${created.confirmationNo}.png`);
        expect(m.attachments).toHaveLength(1);
        const fresh = tokenIn(m.html);
        expect(fresh).not.toBe(created.manageToken);
        expect((await findRegistrationByToken(getDb(), fresh))?.id).toBe(created.id);
        expect(await findRegistrationByToken(getDb(), created.manageToken)).toBeNull(); // only the newest emailed link works
        expect((await row(created.id))!.confirmation_sent_at).not.toBeNull();
        const log = JSON.stringify((await getDb().prepare(`SELECT detail, kind FROM email_log`).all()).results);
        expect(log).not.toContain(fresh);
      });

      it('waitlist: the waitlist notice with a link, a calendar file and no QR', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const created = await register(eventId);
        const decided = await decideRegistration(getDb(), created.id, 'waitlist', null);
        if (!decided.ok) throw new Error('decision failed');
        expect(await sendDecision(env, getDb(), decided)).toBe(true);
        const [m] = mail.sent;
        expect(m.subject).toBe('Update on your registration: Fall <Retreat> & Picnic');
        expect(m.html).toContain('On the waitlist');
        expect(m.html).not.toContain('<img');
        expect(tokenIn(m.html)).not.toBe('');
        expect(m.attachments).toHaveLength(1);
      });

      it('decline: a courteous no with no manage link, no QR, no calendar, and the old link is left alone', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const created = await register(eventId);
        const decided = await decideRegistration(getDb(), created.id, 'decline', null);
        if (!decided.ok) throw new Error('decision failed');
        expect(await sendDecision(env, getDb(), decided)).toBe(true);
        const [m] = mail.sent;
        expect(m.subject).toBe('About your registration: Fall <Retreat> & Picnic');
        expect(m.html).toContain('Not accepted');
        expect(m.html + m.text).not.toMatch(/register\/manage|#t=|<img|qr\//);
        expect(m.attachments).toHaveLength(0);
        expect((await row(created.id))!.manage_token_hash).not.toBeNull();
        expect((await findRegistrationByToken(getDb(), created.manageToken))?.id).toBe(created.id);
      });

      it('freed seats move the waitlist into REVIEW, and that registrant is mailed "waiting for approval" (no QR)', async () => {
        const eventId = await newEvent({ requires_approval: 1, capacity: 1 });
        const first = await register(eventId);
        const second = await register(eventId, { name: '小明', locale: 'en' });
        expect(second.status).toBe('waitlist');
        const decided = await decideRegistration(getDb(), first.id, 'decline', null);
        if (!decided.ok) throw new Error('decision failed');
        expect(decided.promoted).toEqual([second.id]);
        await sendDecision(env, getDb(), decided);
        expect(mail.sent.map((m) => m.kind)).toEqual(['regDecision', 'regPromoted']);
        const promoted = mail.sent[1];
        expect(promoted.to).toContain('@example.com');
        expect(promoted.subject).toBe('A place opened up, waiting for approval: Fall <Retreat> & Picnic');
        expect(promoted.html).not.toMatch(/Confirmed|<img/);
        expect((await row(second.id))!.status).toBe('review');
        expect(tokenIn(promoted.html)).not.toBe('');
      });

      it('skips the decision mail when the registration was changed again meanwhile', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const created = await register(eventId);
        const decided = await decideRegistration(getDb(), created.id, 'accept', null);
        if (!decided.ok) throw new Error('decision failed');
        await getDb().prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1`).bind(created.id).run();
        expect(await sendDecision(env, getDb(), decided)).toBe(false);
        expect(mail.sent).toHaveLength(0);
      });

      it('mails the decision in the registration language', async () => {
        const eventId = await newEvent({ requires_approval: 1 });
        const created = await register(eventId, { locale: 'zh' });
        const decided = await decideRegistration(getDb(), created.id, 'accept', null);
        if (!decided.ok) throw new Error('decision failed');
        await sendDecision(env, getDb(), decided);
        expect(mail.sent[0].subject).toContain('已通过');
        expect(mail.sent[0].subject).toContain('秋季退修会');
      });
    });

    // ── Reminders ────────────────────────────────────────────────────────────
    describe('reminders', () => {
      const soon = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) => newEvent({ starts_at: ts(2 * DAY), ends_at: ts(2 * DAY + 3600_000), reminder_days: 3, titles: { en: { title: 'Fall <Retreat> & Picnic', notes: 'Bring a <dish>' }, zh: { title: '秋季退修会' } }, ...over });

      it('mails confirmed registrations of due events once: details, people, notes, QR and a rotated link, then stamps', async () => {
        const eventId = await soon();
        const created = await register(eventId, { partySize: 2, attendees: [{ name: 'Ada' }, { name: 'Bob' }] });
        const later = await newEvent({ starts_at: ts(10 * DAY), reminder_days: 3 });
        const outside = await register(later);
        const unset = await newEvent({ starts_at: ts(2 * DAY) });
        const noReminder = await register(unset);
        const approvalEvent = await soon({ requires_approval: 1 });
        const inReview = await register(approvalEvent);

        const sent = await sweepReminders(env, getDb());
        expect(sent).toBeGreaterThanOrEqual(1);
        const [m] = mailTo(created.email);
        expect(m).toBeTruthy();
        expect(m.kind).toBe('regReminder');
        expect(m.subject).toBe('Reminder: Fall <Retreat> & Picnic');
        expect(m.html).toContain('Ada, Bob');
        expect(m.html).toContain('Hall A');
        expect(m.html).toContain('Bring a &lt;dish&gt;');
        expect(m.html).toContain(`/register/qr/${eventId}/${created.confirmationNo}.png`);
        const fresh = tokenIn(m.html);
        expect((await findRegistrationByToken(getDb(), fresh))?.id).toBe(created.id);
        expect(await findRegistrationByToken(getDb(), created.manageToken)).toBeNull();
        expect((await row(created.id))!.reminder_sent_at).not.toBeNull();
        expect(mailTo(outside.email)).toHaveLength(0);
        expect(mailTo(noReminder.email)).toHaveLength(0);
        expect(mailTo(inReview.email)).toHaveLength(0); // review registrations are not reminded
        // never twice
        mail.sent.length = 0;
        await sweepReminders(env, getDb());
        expect(mailTo(created.email)).toHaveLength(0);
      });

      it('a failed send releases the claim and rolls the rotation back; the next run sends it', async () => {
        const eventId = await soon();
        const created = await register(eventId);
        mail.failTo.add(created.email);
        await sweepReminders(env, getDb());
        expect((await row(created.id))!.reminder_sent_at).toBeNull();
        expect((await findRegistrationByToken(getDb(), created.manageToken))?.id).toBe(created.id);
        expect(mailTo(created.email)).toHaveLength(0);
        mail.failTo.clear();
        await sweepReminders(env, getDb());
        expect(mailTo(created.email)).toHaveLength(1);
        expect((await row(created.id))!.reminder_sent_at).not.toBeNull();
      });

      it('two overlapping runs send each reminder exactly once', async () => {
        const eventId = await soon();
        const regs = [];
        for (let i = 0; i < 3; i++) regs.push(await register(eventId));
        await Promise.all([sweepReminders(env, getDb()), sweepReminders(env, getDb())]);
        for (const r of regs) expect(mailTo(r.email)).toHaveLength(1);
      });

      it('claims are exclusive: only one caller stamps a registration', async () => {
        const eventId = await soon();
        const created = await register(eventId);
        const claims = await Promise.all([claimReminder(getDb(), created.id), claimReminder(getDb(), created.id), claimReminder(getDb(), created.id)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
      });
    });

    // ── Bulk email ───────────────────────────────────────────────────────────
    describe('bulk email', () => {
      const send = (eventId: number, over: Partial<Parameters<typeof queueBulkEmail>[1]> = {}) =>
        queueBulkEmail(getDb(), { eventId, actor: null, subject: 'News for {name}', body: 'Hi {name}\nSee you at {event} ({confirmation})', audience: {}, ...over });

      it('queues the audience, fills placeholders, escapes everything once and carries no manage link', async () => {
        const eventId = await newEvent({ capacity: 2 });
        const a = await register(eventId, { name: 'Ada <script>x</script>' });
        const b = await register(eventId, { name: 'Bob & Co' });
        const waiting = await register(eventId);
        expect(waiting.status).toBe('waitlist');
        const queued = await send(eventId, { subject: 'News {name}\r\nBcc: evil@example.com', body: 'Hello {name} <b>bold</b> {event} {confirmation} {unknown}\nSecond line' });
        expect(queued).toEqual({ ok: true, queued: 2 });
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 2 });

        const drained = await drainOutbox(env, getDb(), { limit: DRAIN_ON_REQUEST, eventId });
        expect(drained).toMatchObject({ claimed: 2, sent: 2, requeued: 0, failed: 0, skipped: 0 });
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 0, sent: 2 });
        const m = mailTo(a.email)[0];
        expect(m.kind).toBe('regBulk');
        expect(m.subject).toBe('News Ada <script>x</script> Bcc: evil@example.com'); // one line; raw in the subject
        expect(m.html).toContain('Hello Ada &lt;script&gt;x&lt;/script&gt; &lt;b&gt;bold&lt;/b&gt; Fall &lt;Retreat&gt; &amp; Picnic');
        expect(m.html).toContain(a.confirmationNo!);
        expect(m.html).toContain('{unknown}');
        expect(m.html).toContain('<br>Second line');
        expect(m.html).not.toMatch(/<script|<b>|href=|<img/);
        expect(m.text).toContain('Hello Ada <script>x</script> <b>bold</b>'); // plain text stays raw
        expect(m.html + m.text).not.toContain('#t=');
        expect(mailTo(b.email)[0].html).toContain('Bob &amp; Co');
        expect(mailTo(waiting.email)).toHaveLength(0);
        // each queued registration's history says so, with the actor but never the body
        const history = await getDb().prepare(`SELECT action, detail_json FROM reg_activity WHERE registration_id = ?1`).bind(a.id).all<{ action: string; detail_json: string }>();
        expect(history.results.map((h) => h.action)).toContain('bulk_email');
        expect(JSON.stringify(history.results)).not.toContain('Second line');
      });

      it('filters the audience by status and honours the registration language', async () => {
        const eventId = await newEvent({ capacity: 1 });
        await register(eventId);
        const waiting = await register(eventId, { locale: 'zh' });
        expect(await send(eventId, { audience: { statuses: ['waitlist'] } })).toEqual({ ok: true, queued: 1 });
        await drainOutbox(env, getDb(), { limit: 5, eventId });
        const m = mailTo(waiting.email)[0];
        expect(m.text).toContain('您收到这封邮件');
        expect(m.text).toContain('秋季退修会');
      });

      it('validates lengths, the event and an empty audience', async () => {
        const eventId = await newEvent();
        await register(eventId);
        expect(await send(eventId, { subject: '  ' })).toEqual({ ok: false, code: 'invalid' });
        expect(await send(eventId, { body: '' })).toEqual({ ok: false, code: 'invalid' });
        expect(await send(eventId, { subject: 'x'.repeat(201) })).toEqual({ ok: false, code: 'invalid' });
        expect(await send(eventId, { body: 'x'.repeat(10_001) })).toEqual({ ok: false, code: 'invalid' });
        expect(await send(999_999)).toEqual({ ok: false, code: 'event_not_found' });
        expect(await send(eventId, { audience: { statuses: ['cancelled'] } })).toEqual({ ok: true, queued: 0 });
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 0 });
      });

      it('a row that fails or throws never stops the others, and is retried up to three times', async () => {
        const eventId = await newEvent();
        const good = await register(eventId);
        const bad = await register(eventId);
        const exploding = await register(eventId);
        const late = await register(eventId);
        await send(eventId);
        mail.failTo.add(bad.email);
        mail.throwTo.add(exploding.email);
        let r = await drainOutbox(env, getDb(), { limit: 20, eventId });
        expect(r).toMatchObject({ claimed: 4, sent: 2, requeued: 2, failed: 0 });
        expect(mailTo(good.email)).toHaveLength(1);
        expect(mailTo(late.email)).toHaveLength(1);
        r = await drainOutbox(env, getDb(), { limit: 20, eventId });
        expect(r).toMatchObject({ claimed: 2, sent: 0, requeued: 2 });
        r = await drainOutbox(env, getDb(), { limit: 20, eventId });
        expect(r).toMatchObject({ claimed: 2, sent: 0, requeued: 0, failed: 2 });
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 0, sent: 2, failed: 2 });
        r = await drainOutbox(env, getDb(), { limit: 20, eventId });
        expect(r.claimed).toBe(0); // failed rows are never picked up again
        expect(mailTo(good.email)).toHaveLength(1); // and sent rows never go out twice
      });

      it('skips a row whose registration has no address', async () => {
        const eventId = await newEvent();
        const created = await register(eventId);
        await send(eventId);
        await getDb().prepare(`UPDATE registrations SET email = '' WHERE id = ?1`).bind(created.id).run();
        expect(await drainOutbox(env, getDb(), { limit: 5, eventId })).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
      });

      it(`drains at most the limit per call: ${DRAIN_ON_REQUEST} on the request, ${CRON_DRAIN_LIMIT} per cron run`, async () => {
        expect(DRAIN_ON_REQUEST).toBe(20);
        expect(CRON_DRAIN_LIMIT).toBe(60);
        const eventId = await newEvent();
        const created = await register(eventId);
        const total = CRON_DRAIN_LIMIT + 5;
        const stmts = [];
        for (let i = 0; i < total; i++) {
          stmts.push(getDb().prepare(`INSERT INTO reg_outbox (campus_id, event_id, registration_id, kind, subject, body) SELECT campus_id, event_id, id, 'bulk', 'Hi', 'Body' FROM registrations WHERE id = ?1`).bind(created.id));
        }
        await getDb().batch(stmts);
        expect(await drainOutbox(env, getDb(), { limit: DRAIN_ON_REQUEST, eventId })).toMatchObject({ claimed: 20, sent: 20 });
        expect(await sweepOutbox(env, getDb())).toMatchObject({ claimed: total - DRAIN_ON_REQUEST, sent: total - DRAIN_ON_REQUEST });
        expect(await sweepOutbox(env, getDb())).toMatchObject({ claimed: 0 });
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 0, sent: total });
      });
    });

    // ── Module gating ────────────────────────────────────────────────────────
    describe('module gating', () => {
      const dueReminder = async () => {
        const eventId = await newEvent({ starts_at: ts(2 * DAY), reminder_days: 3 });
        return register(eventId);
      };
      const queueOne = async () => {
        const eventId = await newEvent();
        const created = await register(eventId);
        expect(await queueBulkEmail(getDb(), { eventId, actor: null, subject: 'Hi', body: 'Body', audience: {} })).toEqual({ ok: true, queued: 1 });
        return { eventId, created };
      };

      it('with registration off installation-wide, the reminder sweep and the cron drain do nothing', async () => {
        const due = await dueReminder();
        const { eventId, created } = await queueOne();
        await setSetting(getDb(), 'module.registration', '0');
        clearModuleCache();
        try {
          expect(await sweepReminders(env, getDb())).toBe(0);
          expect(await sweepOutbox(env, getDb())).toMatchObject({ claimed: 0, sent: 0 });
        } finally {
          await setSetting(getDb(), 'module.registration', '1');
          clearModuleCache();
        }
        expect(mail.sent).toHaveLength(0);
        expect((await row(due.id))!.reminder_sent_at).toBeNull();
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 1 });
        // and once it is back on, both go out
        expect(await sweepReminders(env, getDb())).toBeGreaterThanOrEqual(1);
        expect(await sweepOutbox(env, getDb())).toMatchObject({ sent: 1 });
        expect(mailTo(created.email)).toHaveLength(1);
        expect(mailTo(due.email)).toHaveLength(1);
      });

      it('with registration off for the registration\'s campus, no reminder goes out and its bulk row is skipped', async () => {
        const due = await dueReminder();
        const { eventId, created } = await queueOne();
        await getDb().prepare(`INSERT INTO campus_modules (campus_id, module_key, enabled) VALUES (1, 'registration', 0)`).run();
        clearModuleCache();
        try {
          await sweepReminders(env, getDb());
          expect(await sweepOutbox(env, getDb())).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
        } finally {
          await getDb().prepare(`DELETE FROM campus_modules WHERE campus_id = 1 AND module_key = 'registration'`).run();
          clearModuleCache();
        }
        expect(mailTo(due.email)).toHaveLength(0);
        expect(mailTo(created.email)).toHaveLength(0);
        expect((await row(due.id))!.reminder_sent_at).toBeNull(); // never claimed, so it is still due when the module is back
        expect(await outboxCounts(getDb(), eventId)).toMatchObject({ queued: 0, skipped: 1 });
      });
    });

    // ── Refunds without Stripe ───────────────────────────────────────────────
    describe('refund bookkeeping', () => {
      it('an offline refund only updates refunded_cents and the history; card payments are refused', async () => {
        const eventId = await newEvent();
        const cash = await register(eventId);
        const card = await register(eventId);
        await getDb().prepare(`UPDATE registrations SET amount_cents = 5000, payment_method = 'offline' WHERE id = ?1`).bind(cash.id).run();
        await getDb().prepare(`UPDATE registrations SET amount_cents = 5000, payment_method = 'stripe', stripe_payment_intent_id = 'pi_card' WHERE id = ?1`).bind(card.id).run();
        expect(await recordOfflineRefund(getDb(), { registrationId: cash.id, amountCents: 1500, actor: null, note: 'Cash back' })).toEqual({ ok: true, refundedCents: 1500, remainingCents: 3500 });
        expect(await recordOfflineRefund(getDb(), { registrationId: cash.id, amountCents: 4000, actor: null })).toEqual({ ok: false, code: 'exceeds_paid' });
        expect(await recordOfflineRefund(getDb(), { registrationId: card.id, amountCents: 100, actor: null })).toEqual({ ok: false, code: 'use_stripe' });
      });

      it('refundRegistration needs Postgres and Stripe: it is refused on D1 and without credentials, and never calls Stripe', async () => {
        const eventId = await newEvent();
        const card = await register(eventId);
        await getDb().prepare(`UPDATE registrations SET amount_cents = 5000, payment_method = 'stripe', stripe_payment_intent_id = 'pi_card' WHERE id = ?1`).bind(card.id).run();
        let called = 0;
        const fetcher = (async () => { called++; return new Response('{}'); }) as typeof fetch;
        const input = { registrationId: card.id, amountCents: 100, actor: null };
        expect(await refundRegistration(env as never, getDb(), input, { fetcher })).toEqual({ ok: false, code: 'unavailable' });
        if (backend === 'd1') {
          const configured = { ...env, STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
          expect(await refundRegistration(configured as never, getDb(), input, { fetcher })).toEqual({ ok: false, code: 'unavailable' });
        }
        expect(called).toBe(0);
      });
    });
  });
}
