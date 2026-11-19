// Registration mail behavior that must hold on BOTH backends: the confirmation (creation
// token, rotation, rollback on a failed send, durable stamp), promotion and cancellation
// mail, the cron retry sweep. Runs against D1 (test/regNotify.d1.test.ts) and Postgres
// (test/pg/regNotify.pg.test.ts); each file mocks src/lib/email with test/shared/regMail.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { findRegistrationByToken } from '../../src/lib/regManage';
import {
  SWEEP_LIMIT,
  cancelAndNotify,
  notifyAfterRelease,
  sendConfirmation,
  sweepUnsentConfirmations,
  type RegNotifyEnv,
} from '../../src/lib/regNotify';
import { mail } from './regMail';
import { ts } from './regCoreCases';

const MIN = 60_000;
const DAY = 24 * 3600_000;
let seq = 0;

export function defineRegNotifyCases(label: string, getDb: () => AppDb, backend: 'd1' | 'supabase'): void {
  const env: RegNotifyEnv & { DB_BACKEND: string } = { DB_BACKEND: backend, APP_ORIGIN: 'https://church.example' };
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(getDb(), { title_en: 'Fall <Retreat> & Picnic', title_zh: '秋季退修会', starts_at: ts(30 * DAY), ends_at: ts(30 * DAY + 2 * 3600_000), location: 'Hall A', active: 1, ...over });
  const register = (eventId: number, over: Partial<Parameters<typeof createRegistration>[1]> = {}) =>
    createRegistration(getDb(), {
      eventId, personId: null, name: 'Ada', email: 'ada@example.com', status: 'confirmed', amountCents: 0,
      currency: 'usd', answers: [], submissionKey: `notify-${Date.now()}-${++seq}`, locale: 'en', ...over,
    });
  const row = (id: number) =>
    getDb().prepare(`SELECT confirmation_sent_at, manage_token_hash, status FROM registrations WHERE id = ?1`).bind(id)
      .first<{ confirmation_sent_at: string | null; manage_token_hash: string | null; status: string }>();
  const age = (id: number, ms: number) =>
    getDb().prepare(`UPDATE registrations SET created_at = ?1 WHERE id = ?2`).bind(ts(-ms), id).run();
  const tokenIn = (html: string): string => /#t=([A-Za-z0-9_-]{43})/.exec(html)?.[1] ?? '';

  describe(`registration mail (${label})`, () => {
    beforeEach(async () => {
      mail.sent.length = 0;
      mail.fail = false;
      await getDb().prepare(`DELETE FROM email_log`).run();
    });

    it('confirms with the creation token (no rotation), stamps the send, attaches the calendar and shows the QR', async () => {
      const eventId = await newEvent();
      const created = await register(eventId, { name: 'Ada <b>Lovelace</b>', partySize: 2, attendees: [{ name: 'Ada <b>Lovelace</b>' }, { name: 'Bob' }] });
      expect(await sendConfirmation(env, getDb(), created.id, { manageToken: created.manageToken })).toBe(true);

      expect(mail.sent).toHaveLength(1);
      const [m] = mail.sent;
      expect(m).toMatchObject({ to: 'ada@example.com', kind: 'regConfirm', redactDevLogBody: true });
      expect(m.subject).toBe('You’re registered: Fall <Retreat> & Picnic'); // raw in the subject
      expect(m.html).toContain('Fall &lt;Retreat&gt; &amp; Picnic'); // escaped once in the HTML
      expect(m.html).toContain('Ada &lt;b&gt;Lovelace&lt;/b&gt;');
      expect(m.html).not.toContain('<b>Lovelace');
      expect(m.html).toContain(`https://church.example/register/qr/${eventId}/${created.confirmationNo}.png`);
      expect(m.text).toContain(`${created.confirmationNo}`);
      expect(m.text).toContain('Fall <Retreat> & Picnic');
      expect(m.attachments).toHaveLength(1);
      expect(m.attachments![0]).toMatchObject({ filename: 'event.ics' });
      expect(String(m.attachments![0].content)).toContain(`UID:registration-${created.id}@church.example`);
      // The link carries the creation token and still works afterwards.
      expect(tokenIn(m.html)).toBe(created.manageToken);
      expect(m.html).toContain('https://church.example/en/register/manage#t=');
      expect((await findRegistrationByToken(getDb(), created.manageToken))?.id).toBe(created.id);
      expect((await row(created.id))!.confirmation_sent_at).not.toBeNull();
      // email_log holds no token.
      const log = await getDb().prepare(`SELECT detail, kind FROM email_log`).all<{ detail: string; kind: string }>();
      expect(JSON.stringify(log.results)).not.toContain(created.manageToken!);
    });

    it('sends a waitlist confirmation (calendar yes, QR no) in the registration language', async () => {
      const eventId = await newEvent({ capacity: 1 });
      await register(eventId);
      const waitlisted = await register(eventId, { name: '小明', email: 'ming@example.com', locale: 'zh' });
      expect(waitlisted.status).toBe('waitlist');
      expect(await sendConfirmation(env, getDb(), waitlisted.id, { manageToken: waitlisted.manageToken })).toBe(true);
      const m = mail.sent[0];
      expect(m.subject).toContain('已加入候补');
      expect(m.subject).toContain('秋季退修会');
      expect(m.html).not.toContain('<img');
      expect(m.attachments).toHaveLength(1);
    });

    it('rotates the manage link when it has no creation token, and rolls the rotation back when the send fails', async () => {
      const eventId = await newEvent();
      const created = await register(eventId);
      mail.fail = true;
      expect(await sendConfirmation(env, getDb(), created.id)).toBe(false);
      expect((await row(created.id))!.confirmation_sent_at).toBeNull();
      // The original link still works: nothing was lost to the failed send.
      expect((await findRegistrationByToken(getDb(), created.manageToken))?.id).toBe(created.id);

      mail.fail = false;
      expect(await sendConfirmation(env, getDb(), created.id)).toBe(true);
      const fresh = tokenIn(mail.sent[0].html);
      expect(fresh).not.toBe('');
      expect(fresh).not.toBe(created.manageToken);
      expect((await findRegistrationByToken(getDb(), fresh))?.id).toBe(created.id);
      expect(await findRegistrationByToken(getDb(), created.manageToken)).toBeNull();
    });

    it('does not mail a pending or cancelled registration', async () => {
      const eventId = await newEvent({ price_cents: 1000 });
      const pending = await register(eventId, { status: 'pending', amountCents: 1000 });
      expect(await sendConfirmation(env, getDb(), pending.id)).toBe(false);
      expect(mail.sent).toHaveLength(0);
    });

    it('mails the paid confirmation with the amount', async () => {
      const eventId = await newEvent({ price_cents: 1250 });
      const paid = await register(eventId, { status: 'confirmed', amountCents: 1250 });
      expect(await sendConfirmation(env, getDb(), paid.id)).toBe(true);
      expect(mail.sent[0].subject).toContain('Payment received');
      expect(mail.sent[0].text).toContain('12.50');
    });

    it('admin cancel promotes the waitlist and mails the cancelled and the promoted registrant', async () => {
      const eventId = await newEvent({ capacity: 1 });
      const first = await register(eventId, { email: 'first@example.com' });
      const second = await register(eventId, { name: 'Second', email: 'second@example.com' });
      expect(second.status).toBe('waitlist');
      expect(await cancelAndNotify(env, getDb(), first.id)).toBe(true);

      expect(mail.sent.map((m) => [m.kind, m.to])).toEqual([
        ['regCancelled', 'first@example.com'],
        ['regPromoted', 'second@example.com'],
      ]);
      const [cancelled, promoted] = mail.sent;
      expect(cancelled.html).not.toContain('#t=');
      expect(cancelled.html).not.toContain('/register/manage');
      expect(cancelled.text).not.toContain('/register/manage');
      expect(cancelled.attachments ?? []).toHaveLength(0);
      // Promotion rotates: the creation-time link is dead, the mailed one works.
      const link = tokenIn(promoted.html);
      expect((await findRegistrationByToken(getDb(), link))?.id).toBe(second.id);
      expect(await findRegistrationByToken(getDb(), second.manageToken)).toBeNull();
      expect(promoted.html).toContain('/register/qr/');
      expect(promoted.attachments).toHaveLength(1);
      // The promotion mail counts as the confirmation: the sweep leaves it alone.
      expect((await row(second.id))!.confirmation_sent_at).not.toBeNull();
      // Cancelling again does nothing and sends nothing.
      mail.sent.length = 0;
      expect(await cancelAndNotify(env, getDb(), first.id)).toBe(false);
      expect(mail.sent).toHaveLength(0);
    });

    it('notifyAfterRelease names the person who left a registration that goes on', async () => {
      const eventId = await newEvent();
      const created = await register(eventId, { partySize: 2, attendees: [{ name: 'Ada' }, { name: 'Bob' }] });
      await notifyAfterRelease(env, getDb(), { cancelledId: created.id, attendeeName: 'Bob', promoted: [] });
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0].kind).toBe('regCancelled');
      expect(mail.sent[0].text).toContain('Bob');
      expect(mail.sent[0].subject).toContain('Registration updated');
    });

    describe('the retry sweep', () => {
      it('mails only unsent confirmed/waitlist registrations older than 15 minutes, once', async () => {
        const eventId = await newEvent({ capacity: 10 });
        const old = await register(eventId, { email: 'old@example.com' });
        const fresh = await register(eventId, { email: 'fresh@example.com' });
        const sent = await register(eventId, { email: 'sent@example.com' });
        await age(old.id, 20 * MIN);
        await age(sent.id, 20 * MIN);
        await getDb().prepare(`UPDATE registrations SET confirmation_sent_at = datetime('now') WHERE id = ?1`).bind(sent.id).run();
        const legacy = await register(eventId, { email: 'legacy@example.com' });
        await getDb().prepare(`UPDATE registrations SET manage_token_hash = NULL, created_at = ?1 WHERE id = ?2`).bind(ts(-DAY), legacy.id).run();
        const pastEvent = await newEvent({ starts_at: ts(-3 * DAY), ends_at: ts(-3 * DAY + 3600_000) });
        const past = await register(pastEvent, { email: 'past@example.com' });
        await age(past.id, 2 * DAY);
        const pending = await register(await newEvent({ price_cents: 500 }), { status: 'pending', amountCents: 500, email: 'pending@example.com' });
        await age(pending.id, 20 * MIN);

        expect(await sweepUnsentConfirmations(env, getDb())).toBe(1);
        expect(mail.sent.map((m) => m.to)).toEqual(['old@example.com']);
        const link = tokenIn(mail.sent[0].html);
        expect((await findRegistrationByToken(getDb(), link))?.id).toBe(old.id); // rotated
        expect(await findRegistrationByToken(getDb(), old.manageToken)).toBeNull();
        expect((await findRegistrationByToken(getDb(), fresh.manageToken))?.id).toBe(fresh.id); // untouched
        expect((await findRegistrationByToken(getDb(), sent.manageToken))?.id).toBe(sent.id);
        expect((await row(legacy.id))!.confirmation_sent_at).toBeNull();
        // Idempotent: nothing left to send, nothing rotates again.
        mail.sent.length = 0;
        expect(await sweepUnsentConfirmations(env, getDb())).toBe(0);
        expect(mail.sent).toHaveLength(0);
        expect((await findRegistrationByToken(getDb(), link))?.id).toBe(old.id);
        // Once the fresh one is old enough, it goes out too.
        await age(fresh.id, 16 * MIN);
        expect(await sweepUnsentConfirmations(env, getDb())).toBe(1);
      });

      it(`handles at most ${SWEEP_LIMIT} per run and keeps links when sends fail`, async () => {
        const eventId = await newEvent();
        const ids: number[] = [];
        for (let i = 0; i < SWEEP_LIMIT + 5; i++) {
          const created = await register(eventId, { email: `bulk${i}@example.com` });
          await age(created.id, 30 * MIN);
          ids.push(created.id);
        }
        mail.fail = true;
        expect(await sweepUnsentConfirmations(env, getDb())).toBe(0);
        // A mail provider outage must not have invalidated any working link.
        for (const id of ids.slice(0, 3)) expect((await row(id))!.manage_token_hash).not.toBeNull();
        mail.fail = false;
        expect(await sweepUnsentConfirmations(env, getDb())).toBe(SWEEP_LIMIT);
        expect(await sweepUnsentConfirmations(env, getDb())).toBe(5);
        expect(await sweepUnsentConfirmations(env, getDb())).toBe(0);
      });
    });
  });
}
