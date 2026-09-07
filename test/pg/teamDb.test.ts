// Team recruiting reads through the real Postgres adapter. These used to fail
// before rendering the leader's team page because json_each is SQLite-only.
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { getMatrix, listPotentialVolunteers } from '../../src/lib/teamDb';
import { scopeDatabase } from '../../src/lib/campusScope';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('team recruiting candidates (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = new PgAdapter(sql);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    await sql.unsafe("INSERT INTO campuses (id,slug,name) VALUES (2,'other','Other Campus')");
  });
  afterAll(async () => { await sql?.end(); });

  beforeEach(async () => {
    await sql.unsafe('TRUNCATE gift_results,person_interests,team_members,teams,people,service_types RESTART IDENTITY CASCADE');
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

  it('keeps candidate sources and latest recommendations inside the real campus-scoped database', async () => {
    await sql.unsafe(`INSERT INTO people (id,display_name,email,home_campus_id)
      VALUES (9,'Other campus','other@example.test',2)`);
    await sql.unsafe(`INSERT INTO person_interests (person_id,category,campus_id)
      VALUES (9,'worship',2),(8,'worship',2)`);
    await sql.unsafe(`INSERT INTO gift_results (id,person_id,top_gifts_json,recommended_json,created_at,campus_id) VALUES
      (100,3,'[]','["children"]','2031-01-01 00:00:00',2),
      (101,9,'[]','["worship"]','2031-01-01 00:00:00',2)`);
    await expect(listPotentialVolunteers(scopeDatabase(db, 1), 'worship', 1, 'supabase')).resolves.toEqual([
      { person_id: 4, display_name: 'Both sources', email: 'both@example.test', via_interest: 1, via_gift: 1 },
      { person_id: 3, display_name: 'Gift only', email: 'gift@example.test', via_interest: 0, via_gift: 1 },
      { person_id: 2, display_name: 'Interest only', email: 'interest@example.test', via_interest: 1, via_gift: 0 },
    ]);
  });

  it('deduplicates matrix rows in team/position order while preserving campus-scoped needs and assignments', async () => {
    await sql.unsafe(`UPDATE teams SET sort=20 WHERE id=1;
      INSERT INTO teams (id,sort,campus_id) VALUES (2,10,1),(3,10,1),(4,0,2);
      INSERT INTO team_i18n (team_id,locale,name,campus_id) VALUES
        (1,'en','Last team',1),(2,'en','First team',1),(3,'en','Middle team',1),(4,'en','Other team',2);
      INSERT INTO positions (id,team_id,sort,campus_id) VALUES
        (1,1,20,1),(2,1,10,1),(3,2,10,1),(4,2,10,1),(5,3,1,1),(6,4,0,2);
      INSERT INTO position_i18n (position_id,locale,name,campus_id) VALUES
        (1,'en','Last position',1),(2,'en','Earlier position',1),(3,'en','First position',1),
        (4,'en','Tied position',1),(5,'en','Middle position',1),(6,'en','Other position',2);
      INSERT INTO service_types (id,campus_id) VALUES (1,1),(2,2);
      INSERT INTO service_type_i18n (service_type_id,locale,name,campus_id) VALUES
        (1,'en','Sunday',1),(2,'en','Other service',2);
      INSERT INTO plans (id,service_type_id,plan_date,campus_id) VALUES
        (1,1,'2030-06-02',1),(2,1,'2030-06-09',1),(3,2,'2030-06-02',2);
      INSERT INTO plan_positions (plan_id,position_id,needed,open_signup,campus_id) VALUES
        (1,1,1,0,1),(1,2,2,1,1),(1,3,1,1,1),(1,4,1,0,1),(1,5,1,0,1),
        (2,2,1,0,1),(2,3,2,1,1),(3,6,1,1,2);
      INSERT INTO roster_assignments (id,plan_id,position_id,person_id,status,campus_id) VALUES
        (1,1,3,1,'C',1),(2,2,2,2,'U',1)`);

    const matrix = await getMatrix(scopeDatabase(db, 1), 1, '2030-06-01', 8, 'en');
    expect(matrix.plans.map(plan => plan.id)).toEqual([1, 2]);
    expect(matrix.rows).toEqual([
      { position_id: 3, position_name: 'First position', team_id: 2, team_name: 'First team' },
      { position_id: 4, position_name: 'Tied position', team_id: 2, team_name: 'First team' },
      { position_id: 5, position_name: 'Middle position', team_id: 3, team_name: 'Middle team' },
      { position_id: 2, position_name: 'Earlier position', team_id: 1, team_name: 'Last team' },
      { position_id: 1, position_name: 'Last position', team_id: 1, team_name: 'Last team' },
    ]);
    expect(matrix.needs).toHaveLength(7);
    expect(matrix.needs).toContainEqual({ plan_id: 2, position_id: 3, needed: 2, open_signup: 1 });
    expect(matrix.needs.some(need => need.plan_id === 3 || need.position_id === 6)).toBe(false);
    expect(matrix.assignments.map(row => ({ id: row.id, person: row.person_id, status: row.status }))).toEqual([
      { id: 1, person: 1, status: 'C' }, { id: 2, person: 2, status: 'U' },
    ]);
  });
});
