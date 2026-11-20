// What a registrant sees of event logistics (D1): the room / table / group lines appear in the manage view and the
// reminder email only when the module is on (the caller's flag) AND the event shows them; an event that does not
// costs no logistics query; the confirmation email never carries them.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRegistration, saveEvent } from '../src/lib/regDb';
import { saveLogisticsSettings } from '../src/lib/regLogistics';
import { addRooms, assignRoom, createVenue, setRoomsConfirmed } from '../src/lib/regHousing';
import { registrationSummary } from '../src/lib/regManage';
import { buildRegistrationView } from '../src/lib/regManageApi';
import { renderRegistrationView } from '../src/lib/regViewHtml';
import { confirmationEmail, reminderEmail } from '../src/lib/regEmails';
import type { AppDb } from '../src/lib/appDb';

const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

async function housedRegistration() {
  const eventId = await saveEvent(env.DB, { title_en: 'Family Camp', starts_at: at(20), active: 1, max_party_size: 4 });
  await saveLogisticsSettings(env.DB, eventId, { housing: true, seating: true });
  const reg = await createRegistration(env.DB, {
    eventId, personId: null, name: 'Ana Lopez', email: `ana-${Date.now()}@example.com`, status: 'confirmed', amountCents: 0, currency: 'usd',
    answers: [], attendees: [{ name: 'Ana Lopez' }, { name: 'Ben Lopez' }], submissionKey: `reg-view-${Date.now()}-${Math.random()}`,
  });
  const venue = await createVenue(env.DB, eventId, { name: 'Pine Lodge', kind: 'hotel' });
  if (!venue.ok) throw new Error('venue');
  const rooms = await addRooms(env.DB, eventId, { venueId: venue.id, labels: '101', bedsOverride: 4 });
  if (!rooms.ok) throw new Error('rooms');
  await setRoomsConfirmed(env.DB, eventId, { roomIds: [rooms.created[0].id], confirmed: true });
  const [ana] = (await env.DB.prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(reg.id).all<{ id: number }>()).results;
  expect(await assignRoom(env.DB, eventId, { attendeeId: ana.id, roomId: rooms.created[0].id, party: false }, { actor: null })).toMatchObject({ ok: true });
  return { eventId, registrationId: reg.id };
}

/** Counts the statements that touch the logistics tables. */
function counting(db: AppDb): { db: AppDb; logistics: () => number } {
  let n = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => {
        if (/reg_room_assignments|reg_table_seats|reg_group_members|housing_enabled/.test(sql)) n++;
        return target.prepare(sql);
      };
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: wrapped as AppDb, logistics: () => n };
}

describe('event logistics for registrants (D1)', () => {
  it('stays hidden until the event shows it, without any logistics query', async () => {
    const { registrationId } = await housedRegistration();
    const probe = counting(env.DB);
    const summary = await registrationSummary(probe.db, registrationId, 'en', undefined, { logistics: true });
    expect(summary!.attendees.every((a) => a.assignments === undefined)).toBe(true);
    expect(probe.logistics()).toBe(0);
    const view = await buildRegistrationView(env.DB, registrationId, 'en', undefined, undefined, { logistics: true });
    expect(view!.attendees.every((a) => a.assignments === undefined)).toBe(true);
  });

  it('shows each person their room (with the place), table and group lines once shown, and the reminder carries them', async () => {
    const { eventId, registrationId } = await housedRegistration();
    await saveLogisticsSettings(env.DB, eventId, { showAssignments: true });
    // The module off (the caller's flag) shows nothing.
    expect((await registrationSummary(env.DB, registrationId, 'en'))!.attendees[0].assignments).toBeUndefined();
    const view = (await buildRegistrationView(env.DB, registrationId, 'en', undefined, undefined, { logistics: true }))!;
    expect(view.attendees[0].assignments).toEqual([{ label: 'Room', value: '101 (Pine Lodge)' }, { label: 'Table', value: 'Not assigned yet' }]);
    expect(view.attendees[1].assignments).toEqual([{ label: 'Room', value: 'Not assigned yet' }, { label: 'Table', value: 'Not assigned yet' }]);
    const html = renderRegistrationView(view, { mode: 'session', action: '/x', labels: {} });
    expect(html).toContain('data-assignments');
    expect(html).toContain('101 (Pine Lodge)');

    const summary = (await registrationSummary(env.DB, registrationId, 'en', undefined, { logistics: true }))!;
    const reminder = reminderEmail(summary, { locale: 'en' });
    expect(reminder.text).toContain('Rooms, tables and groups: Ana Lopez: Room: 101 (Pine Lodge) · Table: not assigned yet');
    expect(reminder.text).toContain('Ben Lopez: Room: not assigned yet · Table: not assigned yet');
    expect(reminder.html).toContain('Ana Lopez: Room: 101 (Pine Lodge) · Table: not assigned yet<br>Ben Lopez');
    expect(confirmationEmail(summary, { locale: 'en' }).text).not.toContain('Rooms, tables and groups');
    // In another language, from the same dictionary.
    const zh = reminderEmail((await registrationSummary(env.DB, registrationId, 'zh', undefined, { logistics: true }))!, { locale: 'zh' });
    expect(zh.text).toContain('房间、餐桌与小组');
  });
});
