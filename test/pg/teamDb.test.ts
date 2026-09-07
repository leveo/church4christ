// Team recruiting reads through the real Postgres adapter. These used to fail
// before rendering the leader's team page because json_each is SQLite-only.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { listPotentialVolunteers } from '../../src/lib/teamDb';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('team recruiting candidates (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = new PgAdapter(sql);

  beforeAll(async () => {
    await resetSchema(sql);
    await sql.unsafe(readFileSync('migrations-supabase/0001_init.sql', 'utf8'));
  });
  afterAll(async () => { await sql?.end(); });

  beforeEach(async () => {
    await sql.unsafe('TRUNCATE gift_results,person_interests,team_members,teams,people RESTART IDENTITY CASCADE');
    await sql.unsafe(`INSERT INTO teams (id) VALUES (1)`);
    await sql.unsafe(`INSERT INTO people (id,display_name,email,active,deleted_at) VALUES
      (1,'Member','member@example.test',1,NULL),
      (2,'Interest only','interest@example.test',1,NULL),
      (3,'Gift only','gift@example.test',1,NULL),
      (4,'Both sources','both@example.test',1,NULL),
      (5,'Inactive','inactive@example.test',0,NULL),
      (6,'Deleted','deleted@example.test',1,'2030-01-01 00:00:00'),
      (7,'Stale result','stale@example.test',1,NULL),
      (8,'Different category','different@example.test',1,NULL)`);
    await sql.unsafe(`INSERT INTO team_members (team_id,person_id) VALUES (1,1)`);
    await sql.unsafe(`INSERT INTO person_interests (person_id,category) VALUES
      (1,'worship'),(2,'worship'),(4,'worship'),(5,'worship'),(6,'worship')`);
    await sql.unsafe(`INSERT INTO gift_results (id,person_id,top_gifts_json,recommended_json,created_at) VALUES
      (1,1,'[]','["worship"]','2030-01-01 00:00:00'),
      (2,3,'[]','["worship","children"]','2030-01-01 00:00:00'),
      (3,4,'[]','["worship","worship"]','2030-01-01 00:00:00'),
      (4,5,'[]','["worship"]','2030-01-01 00:00:00'),
      (5,6,'[]','["worship"]','2030-01-01 00:00:00'),
      (6,7,'[]','["worship"]','2030-01-01 00:00:00'),
      (7,7,'[]','["children"]','2030-02-01 00:00:00'),
      (8,8,'[]','["worship-extra"]','2030-01-01 00:00:00')`);
  });

  it('unions exact latest recommendations and interests with source badges and eligibility exclusions', async () => {
    await expect(listPotentialVolunteers(db, 'worship', 1, 'supabase')).resolves.toEqual([
      { person_id: 4, display_name: 'Both sources', email: 'both@example.test', via_interest: 1, via_gift: 1 },
      { person_id: 3, display_name: 'Gift only', email: 'gift@example.test', via_interest: 0, via_gift: 1 },
      { person_id: 2, display_name: 'Interest only', email: 'interest@example.test', via_interest: 1, via_gift: 0 },
    ]);
  });

  it('uses the newer id for simultaneous retakes while retaining an independent interest', async () => {
    await sql.unsafe(`INSERT INTO gift_results (id,person_id,top_gifts_json,recommended_json,created_at) VALUES
      (9,3,'[]','["children"]','2030-01-01 00:00:00'),
      (10,4,'[]','[]','2030-01-01 00:00:00')`);
    const rows = await listPotentialVolunteers(db, 'worship', 1, 'supabase');
    expect(rows.map(row => ({ id: row.person_id, interest: row.via_interest, gift: row.via_gift }))).toEqual([
      { id: 4, interest: 1, gift: 0 }, { id: 2, interest: 1, gift: 0 },
    ]);
    await expect(listPotentialVolunteers(db, "worship' OR 1=1 --", 1, 'supabase')).resolves.toEqual([]);
  });
});
