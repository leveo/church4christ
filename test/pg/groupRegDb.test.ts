// groupRegDb (the Supabase-only Group ↔ Registration bridge) against real
// Postgres. Migrates + seeds a fresh database the runner way, builds a PgAdapter,
// and exercises link/unlink idempotency, createSpecialEvent (free + active event
// plus link, zh-title fallback), the linked-events list with its confirmed count
// and open flag, the linkable-events picker (excludes already-linked), and the
// per-person registration history reader. Uses the seeded link (group 1 ↔ reg
// event 910) from seed/registration-seed.sql. Self-skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { saveEvent, createRegistration } from '../../src/lib/regDb';
import {
  linkSpecialEvent,
  unlinkSpecialEvent,
  createSpecialEvent,
  listSpecialEventsForGroup,
  listOpenSpecialEventsForGroup,
  listLinkableEvents,
  listRegistrationsForPerson,
} from '../../src/lib/groupRegDb';

const DAY = 24 * 60 * 60 * 1000;
/** A UTC 'YYYY-MM-DD HH:MM:SS' timestamp `offsetMs` from now (matches datetime('now')). */
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

// Seeded fixtures (dev-seed.sql + registration-seed.sql):
// group 1 = public "Young Adults", group 2 = private "Prayer Partners".
// reg event 900 = free retreat (3 confirmed), 910 = paid dinner (2 confirmed, 2 pending).
// group 1 is linked to reg event 910. Person 8 (Ben Wu) has a pending reg for 910.
describe.skipIf(!hasPg)('groupRegDb (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  // ── Seeded link ──────────────────────────────────────────────────────────────
  it('listSpecialEventsForGroup shows the seeded link with confirmed count + open flag', async () => {
    const rows = await listSpecialEventsForGroup(db, 1, 'en');
    const dinner = rows.find((r) => r.id === 910)!;
    expect(dinner).toBeDefined();
    expect(dinner.title).toBe('Marriage Enrichment Dinner'); // en title
    expect(Number(dinner.confirmed_count)).toBe(2); // 2 confirmed (pending excluded)
    expect(Number(dinner.active)).toBe(1);
    expect(Number(dinner.is_open)).toBe(1); // seeded window is open

    // zh locale COALESCEs onto the zh i18n row.
    const zh = await listSpecialEventsForGroup(db, 1, 'zh');
    expect(zh.find((r) => r.id === 910)!.title).toBe('婚姻加添晚宴');

    // The open-only public reader includes the same open event.
    const open = await listOpenSpecialEventsForGroup(db, 1, 'en');
    expect(open.some((r) => r.id === 910)).toBe(true);
  });

  it('listLinkableEvents excludes already-linked events (per group)', async () => {
    const linkable1 = await listLinkableEvents(db, 1);
    expect(linkable1.some((e) => e.id === 910)).toBe(false); // already linked to group 1
    expect(linkable1.some((e) => e.id === 900)).toBe(true); // active + unlinked → offered
    const g900 = linkable1.find((e) => e.id === 900)!;
    expect(g900.title_en).toBe('Fall Family Retreat');
    expect(g900.title_zh).toBe('秋季家庭退修会');

    // group 2 has nothing linked → 910 is linkable there.
    expect((await listLinkableEvents(db, 2)).some((e) => e.id === 910)).toBe(true);
  });

  it('listRegistrationsForPerson returns the person\'s registrations, newest first (localized)', async () => {
    // Seeded: person 8 has one pending registration for event 910.
    const seeded = await listRegistrationsForPerson(db, 8, 'en');
    const dinner = seeded.find((r) => r.event_id === 910)!;
    expect(dinner).toBeDefined();
    expect(dinner.title).toBe('Marriage Enrichment Dinner');
    expect(dinner.status).toBe('pending');
    expect((await listRegistrationsForPerson(db, 8, 'zh')).find((r) => r.event_id === 910)!.title).toBe('婚姻加添晚宴');

    // Add a newer registration for person 8 → it sorts ahead of the seeded one.
    const ev = await saveEvent(db, { title_en: 'Newer', title_zh: '', starts_at: ts(DAY), active: 1 });
    await createRegistration(db, {
      eventId: ev, personId: 8, name: 'Ben Wu', email: 'ben.wu@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [],
    });
    const after = await listRegistrationsForPerson(db, 8, 'en');
    expect(after[0].event_id).toBe(ev); // newest first
    expect(after.length).toBe(seeded.length + 1);
  });

  // ── link / unlink idempotency ────────────────────────────────────────────────
  it('linkSpecialEvent / unlinkSpecialEvent are idempotent', async () => {
    const ev = await saveEvent(db, { title_en: 'Workday', title_zh: '', starts_at: ts(DAY), active: 1 });
    await linkSpecialEvent(db, 2, ev);
    await linkSpecialEvent(db, 2, ev); // repeat → no error, still one row (ON CONFLICT DO NOTHING)
    const [dup] = await sql.unsafe('SELECT count(*)::int AS n FROM group_reg_events WHERE group_id = 2 AND reg_event_id = $1', [ev]);
    expect(Number(dup.n)).toBe(1);
    expect((await listSpecialEventsForGroup(db, 2, 'en')).some((r) => r.id === ev)).toBe(true);

    await unlinkSpecialEvent(db, 2, ev);
    await unlinkSpecialEvent(db, 2, ev); // repeat → no error
    expect((await listSpecialEventsForGroup(db, 2, 'en')).some((r) => r.id === ev)).toBe(false);
  });

  // ── createSpecialEvent ───────────────────────────────────────────────────────
  it('createSpecialEvent creates a free, active event and links it (zh falls back to en)', async () => {
    const id = await createSpecialEvent(db, 2, {
      title_en: 'Game Night', starts_at: ts(2 * DAY), location: 'Cafe', capacity: 12,
    });
    const [row] = await sql.unsafe('SELECT active, price_cents, capacity, location FROM reg_events WHERE id = $1', [id]);
    expect(Number(row.active)).toBe(1);
    expect(row.price_cents).toBeNull(); // default free
    expect(Number(row.capacity)).toBe(12);
    expect(row.location).toBe('Cafe');

    // Linked + listed with a zero confirmed count.
    const listed = (await listSpecialEventsForGroup(db, 2, 'en')).find((r) => r.id === id)!;
    expect(listed).toBeDefined();
    expect(listed.title).toBe('Game Night');
    expect(Number(listed.confirmed_count)).toBe(0);

    // Blank zh title reused the en title.
    const [zh] = await sql.unsafe("SELECT title FROM reg_event_i18n WHERE event_id = $1 AND locale = 'zh'", [id]);
    expect(zh.title).toBe('Game Night');
  });

  it('createSpecialEvent keeps an explicit zh title', async () => {
    const id = await createSpecialEvent(db, 2, { title_en: 'Picnic', title_zh: '野餐', starts_at: ts(DAY) });
    const [zh] = await sql.unsafe("SELECT title FROM reg_event_i18n WHERE event_id = $1 AND locale = 'zh'", [id]);
    expect(zh.title).toBe('野餐');
    expect((await listSpecialEventsForGroup(db, 2, 'zh')).find((r) => r.id === id)!.title).toBe('野餐');
  });
});
