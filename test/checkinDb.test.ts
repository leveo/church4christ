// checkinDb (workers project, live D1). Covers Task 2's slice: check-in events
// admin CRUD (list/save/toggle) and the kiosk household search — digit-mode vs
// name-mode dispatch, LIKE-escaping, phone digit-stripping across households.phone
// and an adult member's people.phone, and the "only households with a child"
// filter. Check-in/checkout/stats land in a later task.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  listEventsAdmin,
  listActiveEvents,
  saveEvent,
  toggleEventActive,
  searchHouseholds,
} from '../src/lib/checkinDb';

async function reset(): Promise<void> {
  // FK dependency order: checkins -> checkin_events / household_members ->
  // households / people.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM checkins'),
    env.DB.prepare('DELETE FROM checkin_events'),
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}
beforeEach(reset);

/** Seed the three households used by the search tests. */
async function seedHouseholds(): Promise<void> {
  const david = await env.DB
    .prepare('INSERT INTO people (display_name, email, phone) VALUES (?, ?, ?) RETURNING id')
    .bind('David Chen', 'david@example.com', '(555) 010-2000')
    .first<{ id: number }>();
  const chen = await env.DB
    .prepare('INSERT INTO households (name, phone) VALUES (?, ?) RETURNING id')
    .bind('Chen Family', '(555) 010-2000')
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, ?, ?, 'adult', 1)`)
      .bind(chen!.id, david!.id, 'David Chen'),
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, NULL, ?, 'child', 0)`)
      .bind(chen!.id, 'Ethan Chen'),
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, NULL, ?, 'child', 0)`)
      .bind(chen!.id, 'Mia Chen'),
  ]);

  const grace = await env.DB
    .prepare('INSERT INTO people (display_name, email, phone) VALUES (?, ?, ?) RETURNING id')
    .bind('Grace Lin', 'grace@example.com', '555-333-4444')
    .first<{ id: number }>();
  const lin = await env.DB
    .prepare('INSERT INTO households (name, phone) VALUES (?, NULL) RETURNING id')
    .bind('Lin Family')
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, ?, ?, 'adult', 1)`)
      .bind(lin!.id, grace!.id, 'Grace Lin'),
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, NULL, ?, 'child', 0)`)
      .bind(lin!.id, 'Noah Lin'),
  ]);

  const zhaoAdult = await env.DB
    .prepare('INSERT INTO people (display_name, email, phone) VALUES (?, ?, ?) RETURNING id')
    .bind('Amy Zhao', 'amy.zhao@example.com', '555-999-0000')
    .first<{ id: number }>();
  const zhao = await env.DB
    .prepare('INSERT INTO households (name, phone) VALUES (?, NULL) RETURNING id')
    .bind('Zhao')
    .first<{ id: number }>();
  await env.DB
    .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, ?, ?, 'adult', 1)`)
    .bind(zhao!.id, zhaoAdult!.id, 'Amy Zhao')
    .run();
}

describe('checkin events admin CRUD', () => {
  it('saveEvent creates and updates; listEventsAdmin returns all', async () => {
    const id = await saveEvent(env.DB, { name: 'Nursery', weekday: 0 });
    expect(id).toBeGreaterThan(0);
    await saveEvent(env.DB, { id, name: 'Nursery (Sunday)', weekday: 0 });
    await saveEvent(env.DB, { name: "Kids' Church", weekday: null });

    const all = await listEventsAdmin(env.DB);
    expect(all).toHaveLength(2);
    const nursery = all.find((e) => e.id === id)!;
    expect(nursery.name).toBe('Nursery (Sunday)');
    expect(nursery.weekday).toBe(0);
  });

  it('listActiveEvents filters by weekday and NULL-weekday events always match', async () => {
    const sunday = await saveEvent(env.DB, { name: 'Sunday Nursery', weekday: 0 });
    const everyday = await saveEvent(env.DB, { name: 'Everyday Kids', weekday: null });
    const wednesday = await saveEvent(env.DB, { name: 'Wednesday Kids', weekday: 3 });

    const onSunday = await listActiveEvents(env.DB, 0);
    expect(onSunday.map((e) => e.id).sort()).toEqual([sunday, everyday].sort());

    const onWednesday = await listActiveEvents(env.DB, 3);
    expect(onWednesday.map((e) => e.id).sort()).toEqual([everyday, wednesday].sort());
  });

  it('toggleEventActive hides event from listActiveEvents', async () => {
    const id = await saveEvent(env.DB, { name: 'Nursery', weekday: null });
    expect(await listActiveEvents(env.DB, 0)).toHaveLength(1);

    await toggleEventActive(env.DB, id, false);
    expect(await listActiveEvents(env.DB, 0)).toHaveLength(0);
    expect((await listEventsAdmin(env.DB)).find((e) => e.id === id)!.active).toBe(0);

    await toggleEventActive(env.DB, id, true);
    expect(await listActiveEvents(env.DB, 0)).toHaveLength(1);
  });
});

describe('searchHouseholds', () => {
  beforeEach(seedHouseholds);

  it('search by partial child name is case-insensitive and returns household with adults+children', async () => {
    const hits = await searchHouseholds(env.DB, 'eth');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Chen Family');
    expect(hits[0].adults).toEqual(expect.arrayContaining(['David Chen']));
    expect(hits[0].children).toEqual(expect.arrayContaining(['Ethan Chen', 'Mia Chen']));
  });

  it('search by phone digits matches household phone regardless of formatting', async () => {
    const hits = await searchHouseholds(env.DB, '0102000');
    expect(hits.map((h) => h.name)).toEqual(['Chen Family']);
  });

  it('search by adult person phone finds the household', async () => {
    const hits = await searchHouseholds(env.DB, '3334444');
    expect(hits.map((h) => h.name)).toEqual(['Lin Family']);
  });

  it('households without children never match', async () => {
    expect(await searchHouseholds(env.DB, 'zhao')).toEqual([]);
  });

  it('LIKE wildcards in query are escaped', async () => {
    expect(await searchHouseholds(env.DB, '%')).toEqual([]);
  });

  it('empty query returns []', async () => {
    expect(await searchHouseholds(env.DB, '')).toEqual([]);
    expect(await searchHouseholds(env.DB, '   ')).toEqual([]);
  });
});
