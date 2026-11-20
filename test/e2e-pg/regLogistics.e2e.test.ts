// Event logistics on the Postgres-backed worker: the representative path through the built worker (rooms by range,
// keep-party-together assignment, the soft confirm, auto-seat preview then apply, and a print with names only).
// The file is reseeded before it runs (test/e2e-pg/setup.ts) and changes only seeded event 920.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const EVENT = '/admin/registration/920';

async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const { db, end } = openDb(env as unknown as DbEnv);
  try {
    return await fn(db);
  } finally {
    await end();
  }
}
const rows = <T>(sql: string, ...binds: unknown[]) => withDb(async (db) => (await db.prepare(sql).bind(...binds).all<T>()).results);

describe('Postgres-backed worker: event logistics', () => {
  it('houses a party together, asks before over-filling, auto-seats from a preview, and prints names only', async () => {
    const admin = `${SESSION_COOKIE}=${await mintSession(SECRET, { id: 1, email: 'admin@example.com', sessionEpoch: 0 })}`;
    const modules = new URLSearchParams({ action: 'modules' });
    for (const key of MODULE_KEYS) modules.append(`module.${key}`, '1');
    expect((await post('/admin/settings', modules.toString(), { cookie: admin })).status).toBe(303);
    await withDb((db) => db.prepare(`UPDATE reg_events SET capacity = NULL, max_party_size = 6, price_cents = NULL, housing_enabled = 1, seating_enabled = 1 WHERE id = 920`).run());
    const act = (fields: Record<string, string | string[]>, query = '') => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
      return post(`${EVENT}${query}`, body.toString(), { cookie: admin });
    };

    expect((await act({ action: 'create', contact_name: 'Ana Lopez', contact_email: 'pg-lopez@example.com', p0_name: '', p1_name: 'Ben Lopez', p2_name: 'Cy Lopez' })).status).toBe(303);
    expect((await act({ action: 'create', contact_name: 'Dee Park', contact_email: 'pg-park@example.com', p0_name: '' })).status).toBe(303);
    const people = await rows<{ id: number; name: string }>(`SELECT a.id AS id, a.name AS name FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = 920 ORDER BY a.id`);
    const ana = Number(people.find((p) => p.name === 'Ana Lopez')!.id);

    expect((await act({ action: 'venue_create', name: 'Pine Lodge', kind: 'hotel' })).status).toBe(303);
    const [venue] = await rows<{ id: number }>(`SELECT id FROM reg_venues WHERE event_id = 920`);
    const added = await act({ action: 'rooms_add', venue_id: String(venue.id), labels: '201-202', beds: '2', policy: 'any', back: 'tab=housing' });
    expect(added.headers.get('location')).toBe(`${EVENT}?tab=housing&notice=lx_rooms_added&n=2&m=0#logistics`);
    const rooms = (await rows<{ id: number }>(`SELECT id FROM reg_rooms WHERE venue_id = ?1 ORDER BY sort`, venue.id)).map((r) => Number(r.id));
    expect((await act({ action: 'rooms_bulk', op: 'confirm', room_ids: rooms.map(String) })).status).toBe(303);

    // Three Lopezes in a two-bed room: asked first, then placed together.
    const asked = await act({ action: 'room_assign', attendee_id: String(ana), room_id: String(rooms[0]), party: ['0', '1'], tab: 'housing' }, '?tab=housing');
    expect(asked.status).toBe(409);
    expect(await asked.text()).toContain('data-confirm-reason="room_over_capacity"');
    expect((await act({ action: 'room_assign', attendee_id: String(ana), room_id: String(rooms[0]), party: ['0', '1'], tab: 'housing', confirm: '1' })).status).toBe(303);
    expect(await rows(`SELECT attendee_id FROM reg_room_assignments WHERE room_id = ?1`, rooms[0])).toHaveLength(3);
    expect(await (await get(`${EVENT}?tab=housing`, { cookie: admin })).text()).toContain('data-testid="lx-housing"');

    // Auto-seat: preview, then apply with the stamp.
    expect((await act({ action: 'tables_add', count: '2', seats: '4', prefix: 'Table' })).status).toBe(303);
    const preview = await (await act({ action: 'seat_preview', start_over: '0', tab: 'tables' }, '?tab=tables')).text();
    expect(preview).toContain('4 people would get a new seat; 0 could not be seated.');
    const stamp = /data-stamp="([^"]+)"/.exec(preview)![1];
    const applied = await act({ action: 'seat_apply', start_over: '0', stamp, tab: 'tables', back: 'tab=tables' });
    expect(applied.headers.get('location')).toBe(`${EVENT}?tab=tables&notice=lx_seat_applied&n=4&m=0#logistics`);
    const seats = await rows<{ table_id: number }>(`SELECT x.table_id AS table_id FROM reg_table_seats x JOIN reg_attendees a ON a.id = x.attendee_id WHERE a.name LIKE '% Lopez'`);
    expect(new Set(seats.map((s) => Number(s.table_id))).size).toBe(1);
    // The same stamp again is stale now.
    expect((await act({ action: 'seat_apply', start_over: '0', stamp, tab: 'tables' })).status).toBe(422);

    const signs = await get(`${EVENT}/door-signs`, { cookie: admin });
    expect(signs.status).toBe(200);
    const html = await signs.text();
    expect(html).toContain('Ben Lopez');
    expect(html).not.toContain('pg-lopez@example.com');
  });
});
