// Event logistics on Postgres (the same cases as test/regLogistics.d1.test.ts), plus what only Postgres can show:
// true two-connection concurrency on the last bed and the last seat. Self-skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { scopeDatabase } from '../../src/lib/campusScope';
import type { AppDb } from '../../src/lib/appDb';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { saveLogisticsSettings } from '../../src/lib/regLogistics';
import { addRooms, assignRoom, createRoomType, createVenue, setRoomsConfirmed } from '../../src/lib/regHousing';
import { addTables, seatAtTable } from '../../src/lib/regSeating';
import { defineRegLogisticsCases, tsAt } from '../shared/regLogisticsCases';

const DAY = 24 * 3600_000;

describe.skipIf(!hasPg)('event logistics (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  defineRegLogisticsCases('Postgres', () => db, 'supabase');
  defineRegLogisticsCases('Postgres, campus-scoped', () => scopeDatabase(db, 1), 'supabase');

  // Every contender gets its OWN connection, so the batches genuinely overlap.
  async function withClients<T>(n: number, run: (dbs: AppDb[]) => Promise<T>): Promise<T> {
    const clients = Array.from({ length: n }, () => pgClient());
    try {
      return await run(clients.map((c) => new PgAdapter(c)));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }
  let seq = 0;
  const person = async (eventId: number, name: string) => {
    const reg = await createRegistration(db, {
      eventId, personId: null, name, email: `${name.toLowerCase()}@example.com`, status: 'confirmed', amountCents: 0, currency: 'usd', answers: [],
      submissionKey: `race-${Date.now()}-${++seq}`,
    });
    return Number((await sql.unsafe('SELECT id FROM reg_attendees WHERE registration_id = $1', [reg.id]))[0].id);
  };
  const event = async () => {
    const eventId = await saveEvent(db, { title_en: 'Race', starts_at: tsAt(30 * DAY), active: 1 });
    await saveLogisticsSettings(db, eventId, { housing: true, seating: true });
    return eventId;
  };

  it('two staff putting different people in the last bed: exactly one gets it, the other is told the room is full', async () => {
    const eventId = await event();
    const venue = await createVenue(db, eventId, { name: 'Dorm', kind: 'dorm' });
    if (!venue.ok) throw new Error('venue');
    const type = await createRoomType(db, eventId, { venueId: venue.id, name: 'Twin', beds: 2 });
    if (!type.ok) throw new Error('type');
    const rooms = await addRooms(db, eventId, { venueId: venue.id, labels: '1', roomTypeId: type.id });
    if (!rooms.ok) throw new Error('rooms');
    const roomId = rooms.created[0].id;
    await setRoomsConfirmed(db, eventId, { roomIds: [roomId], confirmed: true });
    expect(await assignRoom(db, eventId, { attendeeId: await person(eventId, 'Ann'), roomId }, { actor: null })).toMatchObject({ ok: true });
    const contenders = [await person(eventId, 'Ben'), await person(eventId, 'Cal'), await person(eventId, 'Dee'), await person(eventId, 'Eve')];
    const outcomes = await withClients(contenders.length, (dbs) => Promise.all(dbs.map((d, i) => assignRoom(d, eventId, { attendeeId: contenders[i], roomId }, { actor: null }))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual(Array(3).fill({ ok: false, code: 'ROOM_FULL' }));
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM reg_room_assignments WHERE room_id = $1', [roomId]))[0].n).toBe(2);
    expect((await sql.unsafe('SELECT logistics_version FROM reg_events WHERE id = $1', [eventId]))[0].logistics_version).toBeGreaterThan(0);
  });

  it('two staff seating different people at the last seat: exactly one sits, the other must confirm', async () => {
    const eventId = await event();
    const tables = await addTables(db, eventId, { count: 1, seats: 2 });
    if (!tables.ok) throw new Error('tables');
    const tableId = tables.created[0].id;
    expect(await seatAtTable(db, eventId, { attendeeId: await person(eventId, 'Fay'), tableId }, { actor: null })).toMatchObject({ ok: true });
    const contenders = [await person(eventId, 'Gus'), await person(eventId, 'Hal'), await person(eventId, 'Ivy')];
    const outcomes = await withClients(contenders.length, (dbs) => Promise.all(dbs.map((d, i) => seatAtTable(d, eventId, { attendeeId: contenders[i], tableId }, { actor: null }))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual(Array(2).fill({ ok: false, code: 'NEEDS_CONFIRM', reason: 'table_full', reasons: ['table_full'] }));
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM reg_table_seats WHERE table_id = $1', [tableId]))[0].n).toBe(2);
  });
});
