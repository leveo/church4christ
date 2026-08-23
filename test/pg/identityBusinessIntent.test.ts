import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

// The account module also owns recovery flows, whose delivery-only module
// imports the Workers `cloudflare:email` runtime. These business-intent tests
// never enqueue recovery notifications; keep the plain-Node PG project from
// resolving an unrelated Workers-only module.
vi.mock('../../src/lib/identityRecoveryOutbox', () => ({
  prepareIdentityRecoveryNotification: async () => null,
}));

import { PgAdapter } from '../../src/lib/pgAdapter';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { ensureActivePersonContactLink, upsertContactPoint } from '../../src/lib/identityDb';
import { registerIdentitySource } from '../../src/lib/identityGateway';
import {
  beginTeamApplicationIntent,
  completeTeamApplicationIntent,
  createNewcomerObservationIntent,
} from '../../src/lib/identityBusinessIntent';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('identity business intents (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = hasPg ? new PgAdapter(sql) : (null as never);
  const vars = {
    IDENTITY_VERIFICATION_SECRET: 'pg-business-verification-secret-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_SECRET: 'pg-business-stable-source-secret-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_ID: 'v1',
  };
  let sequence = 1_690_000_000;
  const next = () => ++sequence;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });

  it('serializes Team begin/consume and leaves one proof receipt', async () => {
    const teamId = next(); const intentId = crypto.randomUUID();
    await sql.unsafe('INSERT INTO teams(id,campus_id,sort) VALUES($1,1,0)', [teamId]);
    const input = {
      campusId: 1, intentId, teamId, positionId: null, message: 'PG exact intent', name: 'PG Volunteer',
      email: `pg-business-${next()}@example.test`, phone: null, now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.241' }), 'pg-business-device'),
    };
    const begins = await Promise.all([
      beginTeamApplicationIntent(db, vars, input),
      beginTeamApplicationIntent(db, vars, input),
    ]);
    expect(begins.filter((result) => result.status === 'verification_required')).toHaveLength(1);
    const begun = begins.find((result) => result.status === 'verification_required');
    if (!begun || begun.status !== 'verification_required') throw new Error('PG OTP issuance unavailable');
    const completed = await completeTeamApplicationIntent(db, vars, { campusId: 1, intentId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:01:00' });
    expect(completed.status).toBe('consumed');
    expect(Number((await sql.unsafe('SELECT count(*) n FROM team_applications WHERE team_id=$1', [teamId]))[0].n)).toBe(1);
    expect(Number((await sql.unsafe('SELECT count(*) n FROM identity_business_intent_receipts WHERE intent_id=$1', [intentId]))[0].n)).toBe(1);
  });

  it('creates a Newcomer notification-only provisional without an auth owner', async () => {
    const intentId = crypto.randomUUID(); const email = `pg-newcomer-${next()}@example.test`;
    const result = await createNewcomerObservationIntent(db, vars, { campusId: 1, intentId, backend: 'supabase', intake: {
      name: 'PG Newcomer', email, phone: null, locale: 'en', visitDate: '2032-01-01', serviceTypeId: null,
      contactConsent: true, answers: [],
    } });
    expect(result.status).toBe('consumed');
    expect(Number((await sql.unsafe(`SELECT count(*) n FROM newcomer_submissions n JOIN people p ON p.id=n.linked_person_id
      WHERE n.id=$1 AND p.active=0 AND p.identity_state='provisional' AND p.auth_disabled_at IS NOT NULL`, [intentId]))[0].n)).toBe(1);
    expect(Number((await sql.unsafe(`SELECT count(*) n FROM verified_contact_owners o JOIN contact_points cp ON cp.id=o.contact_point_id
      WHERE cp.normalized_value=$1`, [email]))[0].n)).toBe(0);
  });

  it('routes an existing unverified contact link to review without another person or submission', async () => {
    const personId = next(); const email = `pg-shared-unverified-${next()}@example.test`;
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,active,identity_state)
      VALUES($1,'Existing PG Contact',$2,'member',1,'active')`, [personId, `existing-${email}`]);
    const contact = await upsertContactPoint(db, { kind: 'email', value: email });
    await ensureActivePersonContactLink(db, { personId, contactPointId: contact.id, kind: 'email', source: 'test' });
    const before = Number((await sql.unsafe('SELECT count(*) n FROM people'))[0].n);
    const intentId = crypto.randomUUID();
    expect(await createNewcomerObservationIntent(db, vars, { campusId: 1, intentId, backend: 'supabase', intake: {
      name: 'PG Shared Contact', email, phone: null, locale: 'en', visitDate: '2032-01-01', serviceTypeId: null,
      contactConsent: true, answers: [],
    } })).toEqual({ status: 'review' });
    expect(Number((await sql.unsafe('SELECT count(*) n FROM people'))[0].n)).toBe(before);
    expect(Number((await sql.unsafe('SELECT count(*) n FROM newcomer_submissions WHERE id=$1', [intentId]))[0].n)).toBe(0);
  });

  it('serializes two Newcomer sources for one contact into one provisional and one review', async () => {
    const email = `pg-racing-observation-${next()}@example.test`;
    const before = Number((await sql.unsafe('SELECT count(*) n FROM people'))[0].n);
    const intake = { name: 'PG Racing Contact', email, phone: null, locale: 'en' as const, visitDate: '2032-01-01',
      serviceTypeId: null, contactConsent: true, answers: [] };
    const results = await Promise.all([
      createNewcomerObservationIntent(db, vars, { campusId: 1, intentId: crypto.randomUUID(), backend: 'supabase', intake }),
      createNewcomerObservationIntent(db, vars, { campusId: 1, intentId: crypto.randomUUID(), backend: 'supabase', intake }),
    ]);
    expect(results.filter((result) => result.status === 'consumed')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'review')).toHaveLength(1);
    expect(Number((await sql.unsafe('SELECT count(*) n FROM people'))[0].n)).toBe(before + 1);
    expect(Number((await sql.unsafe(`SELECT count(*) n FROM newcomer_submissions n JOIN identity_source_records s
      ON s.id=n.identity_source_record_id JOIN identity_observations o ON o.id=s.observation_id
      WHERE o.normalized_email=$1`, [email]))[0].n)).toBe(1);
  });

  it('keeps legacy person linking mutable but rejects retrofitting an identity source', async () => {
    const personId = next();
    const submissionId = crypto.randomUUID();
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,active,identity_state)
      VALUES($1,'PG Legacy Person',$2,'member',1,'active')`, [personId, `pg-legacy-person-${personId}@example.test`]);
    await sql.unsafe(`INSERT INTO newcomer_submissions(id,name,locale,visit_date,source,status_id)
      VALUES($1,'PG Legacy Newcomer','en','2032-01-01','staff',1)`, [submissionId]);
    await expect(db.prepare('UPDATE newcomer_submissions SET linked_person_id=?1 WHERE id=?2')
      .bind(personId, submissionId).run()).resolves.toMatchObject({ meta: { changes: 1 } });

    const source = await registerIdentitySource(db, vars, {
      campusId: 1, source: 'newcomer', sourceRecordKey: crypto.randomUUID(),
      email: `pg-legacy-retrofit-${next()}@example.test`, phone: null, name: 'PG Legacy Retrofit',
      attachmentPolicy: 'observation_only', sourceDigest: 'c'.repeat(64),
    });
    await expect(db.prepare(`UPDATE newcomer_submissions SET identity_source_record_id=?1
      WHERE id=?2`).bind(source.sourceRecordId, submissionId).run())
      .rejects.toThrow(/identity_newcomer_submission_binding_immutable/);
    await expect(db.prepare(`SELECT identity_source_record_id,linked_person_id
      FROM newcomer_submissions WHERE id=?1`).bind(submissionId).first())
      .resolves.toEqual({ identity_source_record_id: null, linked_person_id: personId });
  });
});
