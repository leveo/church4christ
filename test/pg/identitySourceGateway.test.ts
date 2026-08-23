import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { assignVerifiedContactOwner, ensureActivePersonContactLink, upsertContactPoint } from '../../src/lib/identityDb';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { beginSourceClaim, completeSourceClaim } from '../../src/lib/identityClaim';
import { attachIdentitySourceForSignedInSession, createProvisionalPersonForObservation,
  identityGatewaySessionContext, registerIdentitySource } from '../../src/lib/identityGateway';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('identity source gateway (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const authEnv = {
    IDENTITY_VERIFICATION_SECRET: 'pg-identity-source-secret-that-is-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_SECRET: 'stable-pg-identity-source-key-secret-that-is-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_ID: 'v1',
  };
  let sequence = 1_399_100_000;
  const next = () => ++sequence;
  async function attachAfterHeldWrite(
    statement: string,
    params: unknown[],
    attach: () => Promise<{ status: 'attached'; personId: number }>,
  ) {
    let signalStarted!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mutation = sql.begin(async (tx) => {
      await tx.unsafe(statement, params as never[]);
      signalStarted();
      await gate;
    });
    await started;
    const attaching = attach();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await mutation;
    return Promise.allSettled([attaching]).then(([result]) => result);
  }
  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });

  it('rejects forged direct source inserts with provisional people or inconsistent observation bindings', async () => {
    const db = new PgAdapter(sql);
    await registerIdentitySource(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: `pg-key-pin:${next()}`,
      email: `pg-key-pin-${sequence}@example.test`, attachmentPolicy: 'signed_in_or_claim', sourceDigest: '0'.repeat(64) });
    const provisionalId = next();
    await sql.unsafe(`INSERT INTO people(id,display_name,email,active,identity_state,auth_disabled_at,provisional_source)
      VALUES($1,'PG Forged Provisional',$2,0,'provisional',datetime('now'),'giving')`,
    [provisionalId, `pg-forged-provisional-${provisionalId}@identity.invalid`]);
    const otherCampus = next();
    await sql.unsafe('INSERT INTO campuses(id,slug,name) VALUES($1,$2,$3)',
      [otherCampus, `pg-forged-source-${otherCampus}`, 'PG Forged Source Campus']);
    const cases = [
      { campusId: 1, observationCampus: 1, observationSource: 'giving', status: 'provisional', provisionalPersonId: provisionalId },
      { campusId: 1, observationCampus: 1, observationSource: 'group', status: 'provisional', provisionalPersonId: null },
      { campusId: 1, observationCampus: otherCampus, observationSource: 'giving', status: 'provisional', provisionalPersonId: null },
      { campusId: 1, observationCampus: 1, observationSource: 'giving', status: 'review', provisionalPersonId: null },
    ] as const;
    for (const item of cases) {
      const observationId = next(); const key = next().toString(16).padStart(64, '0');
      await sql.unsafe(`INSERT INTO identity_observations(id,campus_id,source,source_key,status)
        VALUES($1,$2,$3,$4,$5)`,
      [observationId, item.observationCampus, item.observationSource, key, item.status]);
      await expect(sql.unsafe(`INSERT INTO identity_source_records(campus_id,source,source_record_key,source_key_id,observation_id,
        attachment_policy,provisional_person_id,source_digest)
        VALUES($1,'giving',$2,'v1',$3,'signed_in_or_claim',$4,$5)`,
      [item.campusId, key, observationId, item.provisionalPersonId, 'a'.repeat(64)]))
        .rejects.toThrow(/identity_source_insert_invalid/);
    }
  });

  it('installs the parity tables and serializes a guarded signed-session attachment', async () => {
    const tables = await sql.unsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
      AND table_name IN ('identity_source_records','identity_claim_operations','identity_source_attachment_receipts',
        'identity_source_attachment_commits','identity_source_provisional_operations','identity_source_provisional_receipts',
        'identity_source_key_config') ORDER BY table_name`);
    expect(tables.map((row) => row.table_name)).toEqual([
      'identity_claim_operations', 'identity_source_attachment_commits', 'identity_source_attachment_receipts',
      'identity_source_key_config', 'identity_source_provisional_operations', 'identity_source_provisional_receipts',
      'identity_source_records',
    ]);
    await sql.unsafe("INSERT INTO people(id,display_name,email) VALUES(1399000001,'PG Source','pg-source@example.test')");
    const db = new PgAdapter(sql);
    const source = await registerIdentitySource(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: 'pg:source:1',
      email: 'pg-observed@example.test', attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'a'.repeat(64) });
    await expect(registerIdentitySource(db, { ...authEnv,
      IDENTITY_VERIFICATION_SECRET: 'rotated-pg-verification-secret-that-is-at-least-thirty-two-characters' },
    { campusId: 1, source: 'giving', sourceRecordKey: 'pg:source:1', email: 'pg-observed@example.test',
      attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'a'.repeat(64) })).resolves.toEqual(source);
    await expect(registerIdentitySource(db, { ...authEnv,
      IDENTITY_SOURCE_KEY_SECRET: 'rotated-pg-source-key-secret-that-is-at-least-thirty-two-characters' },
    { campusId: 1, source: 'giving', sourceRecordKey: 'pg:source:1', email: 'pg-observed@example.test',
      attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'a'.repeat(64) }))
      .rejects.toThrow(/identity_source_key_configuration_mismatch/);
    expect((await sql.unsafe(`SELECT count(*)::int n FROM identity_source_records
      WHERE campus_id=1 AND source='giving' AND source_record_key=$1`,
    [(await sql.unsafe('SELECT source_record_key FROM identity_source_records WHERE id=$1', [source.sourceRecordId]))[0].source_record_key]))[0].n)
      .toBe(1);
    const context = identityGatewaySessionContext({ personId: 1399000001, campusId: 1, sessionEpoch: 0 });
    const settled = await Promise.all([
      attachIdentitySourceForSignedInSession(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
        expectedVersion: 1, sourceDigest: 'a'.repeat(64), session: context }),
      attachIdentitySourceForSignedInSession(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
        expectedVersion: 1, sourceDigest: 'a'.repeat(64), session: context }),
    ]);
    expect(settled).toEqual([{ status: 'attached', personId: 1399000001 }, { status: 'attached', personId: 1399000001 }]);
    expect((await sql.unsafe('SELECT count(*)::int n FROM identity_source_attachment_receipts WHERE source_record_id=$1', [source.sourceRecordId]))[0].n).toBe(1);
    const storedKey = (await sql.unsafe('SELECT source_record_key FROM identity_source_records WHERE id=$1', [source.sourceRecordId]))[0].source_record_key;
    expect(storedKey).toMatch(/^[0-9a-f]{64}$/);
    expect(storedKey).not.toBe('pg:source:1');
    await expect(sql.unsafe("UPDATE identity_source_records SET state='review',linked_person_id=NULL WHERE id=$1", [source.sourceRecordId]))
      .rejects.toThrow(/identity_source_attachment_immutable/);
    await expect(sql.unsafe('DELETE FROM identity_source_attachment_receipts WHERE source_record_id=$1', [source.sourceRecordId]))
      .rejects.toThrow(/append_only/);
  });

  it('reserves one provisional person under real transaction concurrency without an orphan loser', async () => {
    const db = new PgAdapter(sql);
    const source = await registerIdentitySource(db, authEnv, { campusId: 1, source: 'newcomer',
      sourceRecordKey: `PG Jane +1 415 555 2671 $25 ${next()}`, email: `pg-provisional-${sequence}@example.test`,
      name: `PG Provisional ${sequence}`, attachmentPolicy: 'observation_only', sourceDigest: 'b'.repeat(64) });
    const create = () => createProvisionalPersonForObservation(db, authEnv, { campusId: 1, source: 'newcomer',
      sourceRecordKey: source.sourceRecordKey, expectedVersion: 1, sourceDigest: 'b'.repeat(64) });
    const attempts = await Promise.all([create(), create(), create()]);
    expect(new Set(attempts.map((attempt) => attempt.personId))).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect((await sql.unsafe(`SELECT count(*)::int n FROM identity_source_provisional_operations
      WHERE source_record_id=$1`, [source.sourceRecordId]))[0].n).toBe(1);
    expect((await sql.unsafe(`SELECT count(*)::int n FROM people p JOIN identity_source_provisional_operations op
      ON op.reserved_person_id=p.id WHERE op.source_record_id=$1`, [source.sourceRecordId]))[0].n).toBe(1);

    const raceKey = `pg-provisional-replace:${next()}`;
    const raceInput = { campusId: 1, source: 'newcomer' as const, sourceRecordKey: raceKey,
      email: `pg-provisional-replace-${sequence}@example.test`, name: `PG Replace Race ${sequence}`,
      attachmentPolicy: 'observation_only' as const, sourceDigest: '6'.repeat(64) };
    const raceSource = await registerIdentitySource(db, authEnv, raceInput);
    const [createRace, replaceRace] = await Promise.allSettled([
      createProvisionalPersonForObservation(db, authEnv, { campusId: 1, source: 'newcomer', sourceRecordKey: raceKey,
        expectedVersion: 1, sourceDigest: '6'.repeat(64) }),
      registerIdentitySource(db, authEnv, { ...raceInput, name: 'PG Replace Race Winner', sourceDigest: '7'.repeat(64),
        replaceVersion: { expectedVersion: 1 } }),
    ]);
    expect([createRace.status, replaceRace.status].sort()).toEqual(['fulfilled', 'rejected']);
    const durable = (await sql.unsafe(`SELECT s.version,s.source_digest,s.provisional_person_id,
      (SELECT count(*)::int FROM identity_source_provisional_operations op WHERE op.source_record_id=s.id) operation_count,
      (SELECT count(*)::int FROM identity_source_provisional_receipts r WHERE r.source_record_id=s.id) receipt_count
      FROM identity_source_records s WHERE s.id=$1`, [raceSource.sourceRecordId]))[0];
    if (createRace.status === 'fulfilled') {
      expect(durable).toMatchObject({ version: 1, source_digest: '6'.repeat(64),
        provisional_person_id: createRace.value.personId, operation_count: 1, receipt_count: 1 });
    } else {
      expect(durable).toMatchObject({ version: 2, source_digest: '7'.repeat(64),
        provisional_person_id: null, operation_count: 0, receipt_count: 0 });
    }
  });

  it('serializes a shared-contact race with claim receipt creation and freezes a completed result', async () => {
    const db = new PgAdapter(sql); const owner = next(); const other = next();
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin)
      VALUES($1,'PG Claim Owner',$2,'admin',1),($3,'PG Claim Other',$4,'admin',1)`,
    [owner, `pg-owner-${owner}@example.test`, other, `pg-other-${other}@example.test`]);
    const email = `pg-claim-${owner}@example.test`;
    const contact = await upsertContactPoint(db, { kind: 'email', value: email });
    await ensureActivePersonContactLink(db, { personId: owner, contactPointId: contact.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(db, { campusId: 1, contactPointId: contact.id, personId: owner,
      proof: { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } });
    const source = await registerIdentitySource(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: `pg-claim:${next()}`,
      email, attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'c'.repeat(64) });
    const begun = await beginSourceClaim(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
      expectedVersion: 1, sourceDigest: 'c'.repeat(64), mode: 'otp',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.91' }), `pg-${next()}`),
      now: '2031-06-01 00:00:00' });
    const [completion, sharing] = await Promise.allSettled([
      completeSourceClaim(db, authEnv, { campusId: 1, operationId: begun.public.operationId,
        publicId: begun.delivery.publicId, proof: { kind: 'otp', code: begun.delivery.kind === 'otp' ? begun.delivery.code : '' },
        now: '2031-06-01 00:01:00' }),
      ensureActivePersonContactLink(db, { personId: other, contactPointId: contact.id, kind: 'email', source: 'test' }),
    ]);
    expect(completion.status).toBe('fulfilled');
    const result = completion.status === 'fulfilled' ? completion.value : null;
    expect(result?.status === 'attached' || result?.status === 'review').toBe(true);
    const durable = (await sql.unsafe(`SELECT s.state,s.linked_person_id,op.state operation_state,
      (SELECT count(*)::int FROM identity_source_attachment_receipts r WHERE r.source_record_id=s.id) receipt_count
      FROM identity_source_records s JOIN identity_claim_operations op ON op.source_record_id=s.id WHERE s.id=$1`,
    [source.sourceRecordId]))[0];
    if (result?.status === 'attached') {
      expect(durable).toMatchObject({ state: 'linked', linked_person_id: owner, operation_state: 'completed', receipt_count: 1 });
      await expect(sql.unsafe(`UPDATE identity_claim_operations SET result_person_id=$1 WHERE operation_id=$2`,
        [other, begun.public.operationId])).rejects.toThrow(/identity_claim_operation_completed_immutable/);
    } else {
      expect(durable).toMatchObject({ state: 'review', operation_state: 'review', receipt_count: 0 });
    }
    expect(sharing.status === 'fulfilled' || sharing.status === 'rejected').toBe(true);
  });

  it('rolls back a valid receipt when the exact source CAS updates zero rows', async () => {
    const db = new PgAdapter(sql); const personId = next();
    await sql.unsafe("INSERT INTO people(id,display_name,email) VALUES($1,'PG CAS',$2)", [personId, `pg-cas-${personId}@example.test`]);
    const source = await registerIdentitySource(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: `pg-cas:${next()}`,
      email: `pg-cas-source-${sequence}@example.test`, attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'd'.repeat(64) });
    const receiptId = crypto.randomUUID();
    await expect(db.batch([
      db.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,source_version,
        source_digest,person_id,proof_kind,session_epoch) VALUES(?1,1,?2,1,?3,?4,'signed_session',0)`)
        .bind(receiptId, source.sourceRecordId, 'd'.repeat(64), personId),
      db.prepare("UPDATE identity_source_records SET state='linked',linked_person_id=?1 WHERE id=?2 AND version=999")
        .bind(personId, source.sourceRecordId),
      db.prepare("UPDATE identity_observations SET status='linked',linked_person_id=?1 WHERE id=?2")
        .bind(personId, source.observationId),
    ])).rejects.toThrow(/identity_source_attachment_commit_invalid/);
    expect((await sql.unsafe('SELECT count(*)::int n FROM identity_source_attachment_receipts WHERE receipt_id=$1', [receiptId]))[0].n).toBe(0);
  });

  it('locks the observation so a held dismiss wins cleanly over signed attachment', async () => {
    const db = new PgAdapter(sql); const personId = next();
    await sql.unsafe("INSERT INTO people(id,display_name,email) VALUES($1,'PG Observation Race',$2)",
      [personId, `pg-observation-race-${personId}@example.test`]);
    const source = await registerIdentitySource(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: `pg-observation-race:${next()}`,
      email: `pg-observation-source-${sequence}@example.test`, attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'e'.repeat(64) });
    const context = identityGatewaySessionContext({ personId, campusId: 1, sessionEpoch: 0 });
    const result = await attachAfterHeldWrite(
      "UPDATE identity_observations SET status='dismissed' WHERE id=$1",
      [source.observationId],
      () => attachIdentitySourceForSignedInSession(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
        expectedVersion: 1, sourceDigest: 'e'.repeat(64), session: context }),
    );
    expect(result.status).toBe('rejected');
    expect((await sql.unsafe('SELECT state,linked_person_id FROM identity_source_records WHERE id=$1', [source.sourceRecordId]))[0])
      .toMatchObject({ state: 'unlinked', linked_person_id: null });
    expect((await sql.unsafe('SELECT count(*)::int n FROM identity_source_attachment_receipts WHERE source_record_id=$1',
      [source.sourceRecordId]))[0].n).toBe(0);
  });

  it('locks membership, person eligibility, and merge generation before accepting a signed receipt', async () => {
    const db = new PgAdapter(sql);
    const cases: Array<{
      label: string;
      mutation: (personId: number, canonicalId: number) => { statement: string; params: number[] };
    }> = [
      {
        label: 'membership',
        mutation: (personId: number) => ({ statement: 'UPDATE campus_memberships SET active=0 WHERE person_id=$1 AND campus_id=1', params: [personId] }),
      },
      {
        label: 'auth-disabled',
        mutation: (personId: number) => ({ statement: "UPDATE people SET auth_disabled_at=datetime('now') WHERE id=$1", params: [personId] }),
      },
      {
        label: 'merged',
        mutation: (personId: number, canonicalId: number) => ({
          statement: 'INSERT INTO person_merge_redirects(loser_person_id,canonical_person_id) VALUES($1,$2)',
          params: [personId, canonicalId],
        }),
      },
    ];
    for (const item of cases) {
      const personId = next(); const canonicalId = next();
      await sql.unsafe(`INSERT INTO people(id,display_name,email) VALUES
        ($1,$2,$3),($4,$5,$6)`, [personId, `PG Eligibility ${item.label}`, `pg-eligibility-${personId}@example.test`,
        canonicalId, `PG Canonical ${item.label}`, `pg-canonical-${canonicalId}@example.test`]);
      const source = await registerIdentitySource(db, authEnv, { campusId: 1, source: 'giving',
        sourceRecordKey: `pg-eligibility-${item.label}:${next()}`, email: `pg-eligibility-source-${sequence}@example.test`,
        attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'f'.repeat(64) });
      const context = identityGatewaySessionContext({ personId, campusId: 1, sessionEpoch: 0 });
      const held = item.mutation(personId, canonicalId);
      const result = await attachAfterHeldWrite(held.statement, [...held.params],
        () => attachIdentitySourceForSignedInSession(db, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
          expectedVersion: 1, sourceDigest: 'f'.repeat(64), session: context }));
      expect(result.status, item.label).toBe('rejected');
      expect((await sql.unsafe('SELECT count(*)::int n FROM identity_source_attachment_receipts WHERE source_record_id=$1',
        [source.sourceRecordId]))[0].n, item.label).toBe(0);
      expect((await sql.unsafe('SELECT state,linked_person_id FROM identity_source_records WHERE id=$1', [source.sourceRecordId]))[0], item.label)
        .toMatchObject({ state: 'unlinked', linked_person_id: null });
    }
  });
});
