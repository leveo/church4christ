import type { AppDb } from './appDb';
import { upsertContactPoint } from './identityDb';
import { hasIdentityControlCharacters, normalizeEmail, normalizeName, normalizePhone, type PhoneNormalizationOptions } from './identityNormalize';
import {
  assertIdentitySourcePolicy,
  isIdentitySource,
  type IdentityAttachmentPolicy,
  type IdentitySource,
} from './identitySourceRegistry';

const utf8 = new TextEncoder();
const sourceSessionBrand: unique symbol = Symbol('identity_source_session');

export type IdentitySourceState = 'unlinked' | 'linked' | 'review';
export type IdentitySourceKeyEnv = Readonly<{
  IDENTITY_SOURCE_KEY_SECRET?: string;
  IDENTITY_SOURCE_KEY_ID?: string;
}>;
export type IdentityGatewaySessionContext = Readonly<{
  personId: number;
  campusId: number;
  sessionEpoch: number;
  [sourceSessionBrand]: true;
}>;

export type IdentitySourceRecord = Readonly<{
  sourceRecordId: number;
  observationId: number;
  source: IdentitySource;
  sourceRecordKey: string;
  sourceKeyId: string;
  attachmentPolicy: IdentityAttachmentPolicy;
  version: number;
  sourceDigest: string;
  state: IdentitySourceState;
  linkedPersonId: number | null;
  provisionalPersonId: number | null;
}>;

type SourceRow = {
  id: number;
  observation_id: number;
  source: IdentitySource;
  source_record_key: string;
  source_key_id: string;
  attachment_policy: IdentityAttachmentPolicy;
  version: number;
  source_digest: string;
  state: IdentitySourceState;
  linked_person_id: number | null;
  provisional_person_id: number | null;
  normalized_email: string | null;
  normalized_phone: string | null;
  normalized_name: string | null;
};

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validSourceKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && utf8.encode(value).byteLength <= 512
    && !hasIdentityControlCharacters(value);
}

function sourceKeyConfiguration(env: IdentitySourceKeyEnv): { secret: string; keyId: string } {
  const secret = env?.IDENTITY_SOURCE_KEY_SECRET;
  const keyId = env?.IDENTITY_SOURCE_KEY_ID;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 1024 || /[\s\0-\x1f\x7f]/u.test(secret)) {
    throw new Error('identity_source_key_secret_invalid');
  }
  if (typeof keyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(keyId)) {
    throw new Error('identity_source_key_id_invalid');
  }
  return { secret, keyId };
}

async function hmacSourceValue(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pinnedSourceKeyConfiguration(db: AppDb, env: IdentitySourceKeyEnv): Promise<{ secret: string; keyId: string }> {
  const { secret, keyId } = sourceKeyConfiguration(env);
  const verificationTag = await hmacSourceValue(secret, `identity-source-key-config:v1\0${keyId}`);
  let pinned = await db.prepare(`SELECT key_id,algorithm_version,verification_tag FROM identity_source_key_config
    WHERE singleton_id=1`).first<{ key_id: string; algorithm_version: number; verification_tag: string }>();
  if (!pinned) {
    try {
      await db.prepare(`INSERT INTO identity_source_key_config(singleton_id,key_id,algorithm_version,verification_tag)
        VALUES(1,?1,1,?2)`).bind(keyId, verificationTag).run();
    } catch { /* A concurrent initializer may have pinned the only valid configuration. */ }
    pinned = await db.prepare(`SELECT key_id,algorithm_version,verification_tag FROM identity_source_key_config
      WHERE singleton_id=1`).first<{ key_id: string; algorithm_version: number; verification_tag: string }>();
  }
  if (!pinned || pinned.key_id !== keyId || pinned.algorithm_version !== 1 || pinned.verification_tag !== verificationTag) {
    throw new Error('identity_source_key_configuration_mismatch');
  }
  return { secret, keyId };
}

/** Pins the first source-key configuration and rejects every implicit rotation thereafter. */
export async function ensureIdentitySourceKeyConfiguration(db: AppDb, env: IdentitySourceKeyEnv): Promise<void> {
  await pinnedSourceKeyConfiguration(db, env);
}

async function sourceKeyDigest(db: AppDb, env: IdentitySourceKeyEnv, campusId: number, source: IdentitySource,
  value: string): Promise<{ digest: string; keyId: string }> {
  const { secret, keyId } = await pinnedSourceKeyConfiguration(db, env);
  return {
    keyId,
    digest: await hmacSourceValue(secret, `identity-source-record-key:v2\0${campusId}\0${source}\0${value}`),
  };
}

function databaseId(): number {
  return 1_100_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000);
}

function asRecord(row: SourceRow, callerSourceRecordKey: string): IdentitySourceRecord {
  return Object.freeze({
    sourceRecordId: row.id,
    observationId: row.observation_id,
    source: row.source,
    sourceRecordKey: callerSourceRecordKey,
    sourceKeyId: row.source_key_id,
    attachmentPolicy: row.attachment_policy,
    version: row.version,
    sourceDigest: row.source_digest,
    state: row.state,
    linkedPersonId: row.linked_person_id,
    provisionalPersonId: row.provisional_person_id,
  });
}

export function identityGatewaySessionContext(input: {
  personId: number;
  campusId: number;
  sessionEpoch: number;
}): IdentityGatewaySessionContext {
  if (!validId(input.personId) || !validId(input.campusId) || !validEpoch(input.sessionEpoch)) {
    throw new Error('identity_source_session_invalid');
  }
  const context = { ...input } as IdentityGatewaySessionContext;
  Object.defineProperty(context, sourceSessionBrand, { value: true });
  return Object.freeze(context);
}

function assertSession(context: IdentityGatewaySessionContext, campusId: number): void {
  if (!context || context[sourceSessionBrand] !== true || !Object.isFrozen(context) || context.campusId !== campusId) {
    throw new Error('identity_source_session_invalid');
  }
}

export async function getIdentitySourceRecord(db: AppDb, env: IdentitySourceKeyEnv, input: {
  campusId: number;
  source: IdentitySource;
  sourceRecordKey: string;
}): Promise<SourceRow | null> {
  if (!validId(input.campusId) || !isIdentitySource(input.source) || !validSourceKey(input.sourceRecordKey)) {
    throw new Error('identity_source_invalid');
  }
  const key = await sourceKeyDigest(db, env, input.campusId, input.source, input.sourceRecordKey);
  return db.prepare(`SELECT s.id,s.observation_id,s.source,s.source_record_key,s.source_key_id,s.attachment_policy,s.version,s.source_digest,
      s.state,s.linked_person_id,s.provisional_person_id,o.normalized_email,o.normalized_phone,o.normalized_name
    FROM identity_source_records s JOIN identity_observations o ON o.id=s.observation_id
    WHERE s.campus_id=?1 AND s.source=?2 AND s.source_record_key=?3 AND s.source_key_id=?4`)
    .bind(input.campusId, input.source, key.digest, key.keyId).first<SourceRow>();
}

export async function registerIdentitySource(db: AppDb, env: IdentitySourceKeyEnv, input: {
  campusId: number;
  source: IdentitySource;
  sourceRecordKey: string;
  email?: string | null;
  phone?: string | null;
  phoneOptions?: PhoneNormalizationOptions;
  name?: string | null;
  attachmentPolicy: IdentityAttachmentPolicy;
  sourceDigest: string;
  replaceVersion?: Readonly<{ expectedVersion: number }>;
}): Promise<IdentitySourceRecord> {
  if (!validId(input.campusId) || !isIdentitySource(input.source) || !validSourceKey(input.sourceRecordKey)
    || !validDigest(input.sourceDigest)) throw new Error('identity_source_invalid');
  assertIdentitySourcePolicy(input.source, input.attachmentPolicy);
  const key = await sourceKeyDigest(db, env, input.campusId, input.source, input.sourceRecordKey);
  const keyDigest = key.digest;
  const email = input.email == null ? null : normalizeEmail(input.email);
  const phone = input.phone == null ? null : normalizePhone(input.phone, input.phoneOptions);
  const name = input.name == null ? null : normalizeName(input.name);
  if ((input.email != null && !email) || (input.phone != null && !phone) || (input.name != null && !name)
    || (email === null && phone === null && name === null)) throw new Error('identity_source_payload_invalid');

  const existing = await getIdentitySourceRecord(db, env, input);
  if (existing) {
    const sameObservation = existing.normalized_email === email && existing.normalized_phone === phone && existing.normalized_name === name;
    if (sameObservation && existing.source_digest === input.sourceDigest) return asRecord(existing, input.sourceRecordKey);
    if (!input.replaceVersion) throw new Error('identity_source_payload_drift');
    if (!validId(input.replaceVersion.expectedVersion) || input.replaceVersion.expectedVersion !== existing.version
      || existing.state === 'linked' || existing.provisional_person_id !== null) {
      throw new Error('identity_source_version_conflict');
    }
    try {
      await db.batch([
        db.prepare(`UPDATE identity_source_records SET version=version+1,source_digest=?1,state='unlinked',linked_person_id=NULL,
          updated_at=datetime('now') WHERE id=?2 AND version=?3 AND state<>'linked' AND provisional_person_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM identity_source_provisional_operations op
            WHERE op.source_record_id=identity_source_records.id AND op.source_version=identity_source_records.version
              AND op.source_digest=identity_source_records.source_digest)`)
          .bind(input.sourceDigest, existing.id, input.replaceVersion.expectedVersion),
        db.prepare(`UPDATE identity_observations SET normalized_email=?1,normalized_phone=?2,normalized_name=?3,
          status='provisional',linked_person_id=NULL,updated_at=datetime('now') WHERE id=?4 AND EXISTS (
            SELECT 1 FROM identity_source_records s WHERE s.id=?5 AND s.observation_id=identity_observations.id
              AND s.version=?6 AND s.source_digest=?7 AND s.state='unlinked'
          )`).bind(email, phone, name, existing.observation_id, existing.id, existing.version + 1, input.sourceDigest),
      ]);
    } catch { throw new Error('identity_source_version_conflict'); }
    const replaced = await getIdentitySourceRecord(db, env, input);
    if (!replaced || replaced.version !== existing.version + 1 || replaced.source_digest !== input.sourceDigest
      || replaced.normalized_email !== email || replaced.normalized_phone !== phone || replaced.normalized_name !== name) {
      throw new Error('identity_source_version_conflict');
    }
    return asRecord(replaced, input.sourceRecordKey);
  }

  const priorObservation = await db.prepare(`SELECT id,source_key,normalized_email,normalized_phone,normalized_name,status,linked_person_id
    FROM identity_observations WHERE campus_id=?1 AND source=?2 AND (source_key=?3 OR source_key=?4)
    ORDER BY CASE WHEN source_key=?3 THEN 0 ELSE 1 END LIMIT 1`)
    .bind(input.campusId, input.source, keyDigest, input.sourceRecordKey).first<{
      id: number;
      source_key: string;
      normalized_email: string | null;
      normalized_phone: string | null;
      normalized_name: string | null;
      status: 'provisional' | 'linked' | 'review' | 'dismissed';
      linked_person_id: number | null;
    }>();
  if (priorObservation) {
    if (priorObservation.normalized_email !== email || priorObservation.normalized_phone !== phone
      || priorObservation.normalized_name !== name) throw new Error('identity_source_payload_drift');
    const sourceRecordId = databaseId();
    const mustReview = priorObservation.status !== 'provisional' || priorObservation.linked_person_id !== null;
    try {
      const statements = [];
      if (priorObservation.source_key !== keyDigest) statements.push(
        db.prepare('UPDATE identity_observations SET source_key=?1,updated_at=datetime(\'now\') WHERE id=?2 AND source_key=?3')
          .bind(keyDigest, priorObservation.id, priorObservation.source_key),
      );
      if (mustReview) statements.push(
        db.prepare(`UPDATE identity_observations SET status='provisional',linked_person_id=NULL,updated_at=datetime('now')
          WHERE id=?1`).bind(priorObservation.id),
      );
      statements.push(db.prepare(`INSERT INTO identity_source_records(id,campus_id,source,source_record_key,source_key_id,
        observation_id,attachment_policy,source_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
        .bind(sourceRecordId, input.campusId, input.source, keyDigest, key.keyId, priorObservation.id,
          input.attachmentPolicy, input.sourceDigest));
      if (mustReview) statements.push(
        db.prepare(`UPDATE identity_observations SET status='review',linked_person_id=NULL,updated_at=datetime('now') WHERE id=?1`)
          .bind(priorObservation.id),
        db.prepare(`UPDATE identity_source_records SET state='review',updated_at=datetime('now') WHERE id=?1 AND state='unlinked'`)
          .bind(sourceRecordId),
      );
      await db.batch(statements);
    } catch {
      const raced = await getIdentitySourceRecord(db, env, input);
      if (!raced || raced.source_digest !== input.sourceDigest || raced.normalized_email !== email
        || raced.normalized_phone !== phone || raced.normalized_name !== name) throw new Error('identity_source_conflict');
      return asRecord(raced, input.sourceRecordKey);
    }
    const adopted = await getIdentitySourceRecord(db, env, input);
    if (!adopted) throw new Error('identity_source_unavailable');
    return asRecord(adopted, input.sourceRecordKey);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const observationId = databaseId();
    const sourceRecordId = databaseId();
    try {
      await db.batch([
        db.prepare(`INSERT INTO identity_observations(id,campus_id,source,source_key,normalized_email,normalized_phone,normalized_name,status)
          VALUES(?1,?2,?3,?4,?5,?6,?7,'provisional')`)
          .bind(observationId, input.campusId, input.source, keyDigest, email, phone, name),
        db.prepare(`INSERT INTO identity_source_records(id,campus_id,source,source_record_key,source_key_id,
          observation_id,attachment_policy,source_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
          .bind(sourceRecordId, input.campusId, input.source, keyDigest, key.keyId, observationId,
            input.attachmentPolicy, input.sourceDigest),
      ]);
      const created = await getIdentitySourceRecord(db, env, input);
      if (!created) throw new Error('identity_source_unavailable');
      return asRecord(created, input.sourceRecordKey);
    } catch {
      const raced = await getIdentitySourceRecord(db, env, input);
      if (raced) {
        if (raced.source_digest === input.sourceDigest && raced.normalized_email === email
          && raced.normalized_phone === phone && raced.normalized_name === name) return asRecord(raced, input.sourceRecordKey);
        throw new Error('identity_source_payload_drift');
      }
    }
  }
  throw new Error('identity_source_unavailable');
}

export async function attachIdentitySourceForSignedInSession(db: AppDb, env: IdentitySourceKeyEnv, input: {
  campusId: number;
  source: IdentitySource;
  sourceRecordKey: string;
  expectedVersion: number;
  sourceDigest: string;
  expectedSourceRecordId?: number;
  session: IdentityGatewaySessionContext;
}): Promise<{ status: 'attached'; personId: number }> {
  assertSession(input.session, input.campusId);
  if (!validId(input.expectedVersion) || !validDigest(input.sourceDigest)
    || (input.expectedSourceRecordId !== undefined && !validId(input.expectedSourceRecordId))) throw new Error('identity_source_invalid');
  const source = await getIdentitySourceRecord(db, env, input);
  if (!source) throw new Error('identity_source_not_found');
  if (input.expectedSourceRecordId !== undefined && source.id !== input.expectedSourceRecordId) {
    throw new Error('identity_source_record_mismatch');
  }
  if (source.provisional_person_id !== null) throw new Error('identity_source_reconciliation_required');
  if (source.attachment_policy !== 'signed_in_or_claim') throw new Error('identity_source_attachment_not_allowed');
  if (source.version !== input.expectedVersion || source.source_digest !== input.sourceDigest) throw new Error('identity_source_version_conflict');
  if (source.linked_person_id !== null) {
    if (source.linked_person_id !== input.session.personId) throw new Error('identity_source_already_attached');
    return { status: 'attached', personId: source.linked_person_id };
  }
  if (source.state !== 'unlinked') throw new Error('identity_source_attachment_not_allowed');
  const eligible = await db.prepare(`SELECT p.id FROM people p JOIN campus_memberships cm ON cm.person_id=p.id
    LEFT JOIN person_merge_redirects redirect ON redirect.loser_person_id=p.id
    WHERE p.id=?1 AND cm.campus_id=?2 AND cm.active=1 AND p.session_epoch=?3 AND p.active=1 AND p.deleted_at IS NULL
      AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND redirect.loser_person_id IS NULL`)
    .bind(input.session.personId, input.campusId, input.session.sessionEpoch).first<number>('id');
  if (eligible !== input.session.personId) throw new Error('identity_source_session_invalid');
  const receiptId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,source_version,source_digest,
        person_id,proof_kind,session_epoch) VALUES(?1,?2,?3,?4,?5,?6,'signed_session',?7)`)
        .bind(receiptId, input.campusId, source.id, source.version, source.source_digest, input.session.personId, input.session.sessionEpoch),
      db.prepare(`UPDATE identity_source_records SET state='linked',linked_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND state='unlinked' AND version=?3 AND source_digest=?4`)
        .bind(input.session.personId, source.id, source.version, source.source_digest),
      db.prepare(`UPDATE identity_observations SET status='linked',linked_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND status<>'dismissed'`).bind(input.session.personId, source.observation_id),
      db.prepare(`INSERT INTO identity_source_attachment_commits(commit_id,campus_id,receipt_id,source_record_id,person_id)
        VALUES(?1,?2,?3,?4,?5)`).bind(crypto.randomUUID(), input.campusId, receiptId, source.id, input.session.personId),
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,actor_person_id,subject_person_id,metadata_json)
        VALUES(?1,'identity_source_signed_attachment',?2,?2,'{}')`).bind(input.campusId, input.session.personId),
    ]);
  } catch {
    const saved = await getIdentitySourceRecord(db, env, input);
    if (saved?.linked_person_id === input.session.personId && saved.version === source.version && saved.source_digest === source.source_digest) {
      const committed = await db.prepare(`SELECT 1 ok FROM identity_source_attachment_receipts r
        JOIN identity_source_attachment_commits c ON c.receipt_id=r.receipt_id
        WHERE r.source_record_id=?1 AND r.person_id=?2 AND r.source_version=?3 AND r.source_digest=?4
          AND c.source_record_id=r.source_record_id AND c.person_id=r.person_id`)
        .bind(source.id, input.session.personId, source.version, source.source_digest).first<number>('ok');
      if (committed === 1) return { status: 'attached', personId: input.session.personId };
    }
    throw new Error('identity_source_attachment_conflict');
  }
  const committed = await db.prepare(`SELECT 1 ok FROM identity_source_records s
    JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
    JOIN identity_source_attachment_commits c ON c.receipt_id=r.receipt_id AND c.source_record_id=s.id
    JOIN identity_observations o ON o.id=s.observation_id
    WHERE s.id=?1 AND s.state='linked' AND s.linked_person_id=?2 AND s.version=?3 AND s.source_digest=?4
      AND r.person_id=?2 AND r.source_version=?3 AND r.source_digest=?4 AND r.proof_kind='signed_session'
      AND c.person_id=?2
      AND o.status='linked' AND o.linked_person_id=?2`).bind(source.id, input.session.personId, source.version, source.source_digest)
    .first<number>('ok');
  if (committed !== 1) throw new Error('identity_source_attachment_conflict');
  return { status: 'attached', personId: input.session.personId };
}

export async function createProvisionalPersonForObservation(db: AppDb, env: IdentitySourceKeyEnv, input: {
  campusId: number;
  source: IdentitySource;
  sourceRecordKey: string;
  expectedVersion: number;
  sourceDigest: string;
}): Promise<{ personId: number; created: boolean }> {
  if (!validId(input.expectedVersion) || !validDigest(input.sourceDigest)) throw new Error('identity_source_invalid');
  const source = await getIdentitySourceRecord(db, env, input);
  if (!source) throw new Error('identity_source_not_found');
  if (source.version !== input.expectedVersion || source.source_digest !== input.sourceDigest || source.linked_person_id !== null) {
    throw new Error('identity_source_version_conflict');
  }
  if (!(['group', 'newcomer', 'import'] as IdentitySource[]).includes(source.source)
    || source.attachment_policy !== 'observation_only' || source.state !== 'unlinked') {
    throw new Error('identity_source_provisional_not_allowed');
  }
  if (source.provisional_person_id !== null) return { personId: source.provisional_person_id, created: false };
  if (!source.normalized_email && !source.normalized_phone) throw new Error('identity_source_notification_contact_required');
  const contacts = [];
  if (source.normalized_email) contacts.push(await upsertContactPoint(db, { kind: 'email', value: source.normalized_email }));
  if (source.normalized_phone) contacts.push(await upsertContactPoint(db, { kind: 'phone', value: source.normalized_phone }));
  for (const contact of contacts) {
    const collision = await db.prepare(`SELECT 1 ok WHERE
      EXISTS (SELECT 1 FROM verified_contact_owners v WHERE v.contact_point_id=?1)
      OR EXISTS (SELECT 1 FROM person_contact_links l WHERE l.contact_point_id=?1 AND l.ended_at IS NULL)
      OR EXISTS (SELECT 1 FROM household_contact_links h WHERE h.contact_point_id=?1 AND h.ended_at IS NULL)`)
      .bind(contact.id).first<number>('ok');
    if (collision === 1) throw new Error('identity_source_provisional_contact_review_required');
  }
  const personId = databaseId();
  const operationId = crypto.randomUUID();
  const syntheticEmail = `provisional+${crypto.randomUUID()}@identity.invalid`;
  const displayName = source.normalized_name ?? 'Provisional person';
  try {
    await db.batch([
      db.prepare(`INSERT INTO identity_source_provisional_operations(operation_id,campus_id,source_record_id,source_version,
        source_digest,reserved_person_id) VALUES(?1,?2,?3,?4,?5,?6)`)
        .bind(operationId, input.campusId, source.id, source.version, source.source_digest, personId),
      db.prepare(`INSERT INTO people(id,display_name,email,role,active,home_campus_id,membership_status,identity_state,auth_disabled_at,provisional_source)
        VALUES(?1,?2,?3,'member',0,?4,'visitor','provisional',datetime('now'),?5)`)
        .bind(personId, displayName, syntheticEmail, input.campusId, source.source),
      ...contacts.map((contact) => db.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled)
        VALUES(?1,?2,?3,'source_notification',0,1)`).bind(personId, contact.id, contact.kind)),
      db.prepare(`UPDATE identity_source_records SET provisional_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND provisional_person_id IS NULL AND linked_person_id IS NULL AND version=?3 AND source_digest=?4`)
        .bind(personId, source.id, source.version, source.source_digest),
      db.prepare(`INSERT INTO identity_source_provisional_receipts(receipt_id,campus_id,operation_id,source_record_id,
        source_version,source_digest,person_id) VALUES(?1,?2,?3,?4,?5,?6,?7)`)
        .bind(crypto.randomUUID(), input.campusId, operationId, source.id, source.version, source.source_digest, personId),
    ]);
  } catch {
    const saved = await getIdentitySourceRecord(db, env, input);
    if (saved && saved.provisional_person_id !== null) return { personId: saved.provisional_person_id, created: false };
    throw new Error('identity_source_provisional_conflict');
  }
  const committed = await db.prepare(`SELECT 1 ok FROM identity_source_records s
    JOIN identity_source_provisional_operations op ON op.source_record_id=s.id AND op.reserved_person_id=s.provisional_person_id
    JOIN identity_source_provisional_receipts r ON r.operation_id=op.operation_id AND r.source_record_id=s.id
    JOIN people p ON p.id=s.provisional_person_id
    WHERE s.id=?1 AND s.provisional_person_id=?2 AND s.state='unlinked' AND s.version=?3 AND s.source_digest=?4
      AND r.person_id=p.id AND r.source_version=s.version AND r.source_digest=s.source_digest
      AND p.active=0 AND p.identity_state='provisional' AND p.auth_disabled_at IS NOT NULL`)
    .bind(source.id, personId, source.version, source.source_digest).first<number>('ok');
  if (committed !== 1) throw new Error('identity_source_provisional_conflict');
  return { personId, created: true };
}
