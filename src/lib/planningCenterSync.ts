import type { AppDb } from './appDb';
import { findVerifiedContactOwner } from './identityDb';
import { registerIdentitySource, type IdentitySourceKeyEnv } from './identityGateway';
import { normalizeEmail, normalizeName, normalizePhone } from './identityNormalize';
import { fetchPlanningCenterPage, nextPlanningCenterUrl, PlanningCenterNotFoundError, PlanningCenterRateLimitError, sha256Utf8, type PlanningCenterPage } from './planningCenterClient';

export type PlanningCenterCredentialEnv = IdentitySourceKeyEnv & Readonly<{
  PLANNING_CENTER_CLIENT_ID?: string;
  PLANNING_CENTER_SECRET?: string;
  PLANNING_CENTER_WEBHOOK_SECRET?: string;
  PLANNING_CENTER_USER_AGENT?: string;
}>;

export type PlanningCenterCredentials = Readonly<{
  clientId: string; secret: string; webhookSecret: string; userAgent: string;
}>;

const USER_AGENT_PATTERN = /^.{2,120} (?:<(?:https?:\/\/[^ <>]{1,120}|mailto:[^ <>]{3,120})>|\((?:https?:\/\/[^ <>]{1,120}|[^ ()<>@]{1,64}@[^ ()<>]{1,120})\))$/u;

export function planningCenterCredentials(env: PlanningCenterCredentialEnv): PlanningCenterCredentials {
  const clientId = env?.PLANNING_CENTER_CLIENT_ID;
  const secret = env?.PLANNING_CENTER_SECRET;
  const webhookSecret = env?.PLANNING_CENTER_WEBHOOK_SECRET;
  const userAgent = env?.PLANNING_CENTER_USER_AGENT;
  if ([clientId, secret, webhookSecret, userAgent].some((value) => value === undefined)) {
    if ([clientId, secret, webhookSecret, userAgent].every((value) => value === undefined)) throw new Error('planning_center_not_configured');
    throw new Error('planning_center_credentials_incomplete');
  }
  if (typeof clientId !== 'string' || clientId.length < 1 || clientId.length > 512 || /[\s\0-\x1f\x7f]/u.test(clientId)
    || typeof secret !== 'string' || secret.length < 8 || secret.length > 4096 || /[\s\0-\x1f\x7f]/u.test(secret)
    || typeof webhookSecret !== 'string' || webhookSecret.length < 16 || webhookSecret.length > 4096 || /[\s\0-\x1f\x7f]/u.test(webhookSecret)
    || typeof userAgent !== 'string' || userAgent.length < 8 || userAgent.length > 256 || /[\0-\x1f\x7f]/u.test(userAgent) || !USER_AGENT_PATTERN.test(userAgent)) {
    throw new Error('planning_center_credentials_invalid');
  }
  return Object.freeze({ clientId, secret, webhookSecret, userAgent });
}

export function planningCenterDatabaseId(): number {
  return 1_100_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000);
}

function leaseUntil(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export type PlanningCenterSyncLease = Readonly<{ jobId: number; connectionId: number; stream: 'people' | 'person_mergers'; token: string; leaseUntil: string }>;

const PLANNING_CENTER_CONNECTION_BATCH_SIZE = 32;

export async function ensurePlanningCenterSyncJob(db: AppDb, input: { connectionId: number; stream: 'people' | 'person_mergers' }): Promise<void> {
  if (!Number.isSafeInteger(input.connectionId) || input.connectionId < 1) throw new Error('planning_center_connection_invalid');
  await db.prepare(`INSERT INTO planning_center_sync_jobs(id,connection_id,stream) VALUES(?1,?2,?3) ON CONFLICT(connection_id,stream) DO NOTHING`)
    .bind(planningCenterDatabaseId(), input.connectionId, input.stream).run();
}

/** Explicitly requests a bounded full pass for one connection (or all active connections). */
export async function enqueuePlanningCenterSyncJobs(db: AppDb, input: { connectionId?: number } = {}): Promise<number> {
  if (input.connectionId !== undefined && (!Number.isSafeInteger(input.connectionId) || input.connectionId < 1)) throw new Error('planning_center_connection_invalid');
  const rows = input.connectionId === undefined
    ? (await db.prepare(`SELECT c.id FROM planning_center_connections c WHERE c.state='active'
        ORDER BY CASE WHEN EXISTS (SELECT 1 FROM planning_center_sync_jobs j
          WHERE j.connection_id=c.id AND j.state IN ('pending','running')) THEN 1 ELSE 0 END,
          CASE WHEN c.last_success_at IS NULL THEN 0 ELSE 1 END,c.last_success_at,c.id
        LIMIT ${PLANNING_CENTER_CONNECTION_BATCH_SIZE}`).all<{ id: number }>()).results
    : [{ id: input.connectionId }];
  for (const row of rows) {
    await enqueuePlanningCenterSyncJob(db, { connectionId: row.id, stream: 'people' });
    await enqueuePlanningCenterSyncJob(db, { connectionId: row.id, stream: 'person_mergers' });
  }
  return rows.length;
}

/** Hourly traffic-independent reconciliation trigger; succeeded jobs stay quiescent between due passes. */
export async function enqueueDuePlanningCenterSyncJobs(db: AppDb, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const canonicalTimestamp = `(LENGTH(c.last_success_at)=19
      AND SUBSTR(c.last_success_at,5,1)='-' AND SUBSTR(c.last_success_at,8,1)='-'
      AND SUBSTR(c.last_success_at,11,1) IN (' ','T')
      AND SUBSTR(c.last_success_at,14,1)=':' AND SUBSTR(c.last_success_at,17,1)=':')`;
  const rows = (await db.prepare(`SELECT c.id,c.last_success_at FROM planning_center_connections c
    WHERE c.state='active' AND (c.last_success_at IS NULL OR NOT ${canonicalTimestamp}
      OR REPLACE(SUBSTR(c.last_success_at,1,19),'T',' ')<=?1)
    ORDER BY CASE WHEN EXISTS (SELECT 1 FROM planning_center_sync_jobs j
      WHERE j.connection_id=c.id AND j.state IN ('pending','running')) THEN 1 ELSE 0 END,
      CASE WHEN c.last_success_at IS NULL OR NOT ${canonicalTimestamp} THEN 0 ELSE 1 END,
      REPLACE(SUBSTR(c.last_success_at,1,19),'T',' '),c.id
    LIMIT ${PLANNING_CENTER_CONNECTION_BATCH_SIZE}`).bind(cutoff).all<{ id: number; last_success_at: string | Date | null }>()).results;
  const due = rows.filter((row) => {
    if (!row.last_success_at) return true;
    const parsed = row.last_success_at instanceof Date
      ? row.last_success_at.getTime()
      : Date.parse(row.last_success_at.includes('T') ? row.last_success_at : `${row.last_success_at.replace(' ', 'T')}Z`);
    return !Number.isFinite(parsed) || parsed <= now.getTime() - 60 * 60 * 1000;
  });
  for (const row of due) {
    await enqueuePlanningCenterSyncJob(db, { connectionId: row.id, stream: 'people' });
    await enqueuePlanningCenterSyncJob(db, { connectionId: row.id, stream: 'person_mergers' });
  }
  return due.length;
}

/** Explicitly enqueue work; a completed cursor is never re-run by a sweep. */
export async function enqueuePlanningCenterSyncJob(db: AppDb, input: { connectionId: number; stream: 'people' | 'person_mergers'; cursor?: string | null }): Promise<void> {
  if (!Number.isSafeInteger(input.connectionId) || input.connectionId < 1) throw new Error('planning_center_connection_invalid');
  if (input.cursor !== undefined && (input.cursor === null || input.cursor.length < 1 || input.cursor.length > 2048)) throw new Error('planning_center_cursor_invalid');
  await db.prepare(`INSERT INTO planning_center_sync_jobs(id,connection_id,stream,state,cursor,pending_cursor,rerun_requested,not_before) VALUES(?1,?2,?3,'pending',?4,NULL,0,NULL)
    ON CONFLICT(connection_id,stream) DO UPDATE SET
      state=CASE WHEN planning_center_sync_jobs.state='running' THEN 'running' ELSE 'pending' END,
      cursor=CASE WHEN planning_center_sync_jobs.state='running' THEN planning_center_sync_jobs.cursor WHEN ?4 IS NULL THEN planning_center_sync_jobs.cursor ELSE ?4 END,
      pending_cursor=CASE WHEN planning_center_sync_jobs.state='running' THEN COALESCE(?4,planning_center_sync_jobs.pending_cursor) ELSE NULL END,
      rerun_requested=CASE WHEN planning_center_sync_jobs.state='running' THEN 1 ELSE 0 END,
      not_before=planning_center_sync_jobs.not_before,updated_at=CURRENT_TIMESTAMP`)
    .bind(planningCenterDatabaseId(), input.connectionId, input.stream, input.cursor ?? null).run();
}

export async function claimPlanningCenterSyncJob(db: AppDb, input: {
  connectionId: number; stream: 'people' | 'person_mergers'; now?: Date; leaseSeconds?: number;
}): Promise<PlanningCenterSyncLease | null> {
  await ensurePlanningCenterSyncJob(db, input);
  const now = input.now ?? new Date();
  const seconds = input.leaseSeconds ?? 300;
  if (!Number.isFinite(seconds) || seconds < 30 || seconds > 900) throw new Error('planning_center_lease_invalid');
  const token = crypto.randomUUID();
  const tokenHash = await sha256Utf8(`planning-center-lease:v1\0${token}`);
  const until = leaseUntil(now, seconds);
  const result = await db.prepare(`UPDATE planning_center_sync_jobs SET state='running',lease_token_hash=?1,lease_until=?2,
      not_before=NULL,attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE connection_id=?3 AND stream=?4
      AND (state IN ('pending','failed') OR (state='running' AND lease_until<=?5))
      AND (not_before IS NULL OR not_before<=?5)`)
    .bind(tokenHash, until, input.connectionId, input.stream, now.toISOString()).run();
  if ((result.meta?.changes ?? 0) !== 1) return null;
  const row = await db.prepare(`SELECT id,connection_id,stream FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream=?2 AND lease_token_hash=?3 AND state='running'`)
    .bind(input.connectionId, input.stream, tokenHash).first<{ id: number; connection_id: number; stream: 'people' | 'person_mergers' }>();
  if (!row) throw new Error('planning_center_lease_unavailable');
  return Object.freeze({ jobId: row.id, connectionId: row.connection_id, stream: row.stream, token, leaseUntil: until });
}

export async function completePlanningCenterSyncJob(db: AppDb, input: { lease: PlanningCenterSyncLease; nextUrl: string | null; now?: Date }): Promise<boolean> {
  const hash = await sha256Utf8(`planning-center-lease:v1\0${input.lease.token}`);
  const result = await db.prepare(`UPDATE planning_center_sync_jobs SET
    state=CASE WHEN rerun_requested=1 OR CAST(?1 AS TEXT) IS NOT NULL THEN 'pending' ELSE 'succeeded' END,
    cursor=CASE WHEN rerun_requested=1 AND pending_cursor IS NOT NULL THEN pending_cursor ELSE CAST(?1 AS TEXT) END,
    pending_cursor=NULL,rerun_requested=0,lease_token_hash=NULL,lease_until=NULL,last_error_code=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=?2 AND connection_id=?3 AND stream=?4 AND state='running' AND lease_token_hash=?5 AND lease_until>?6`)
    .bind(input.nextUrl, input.lease.jobId, input.lease.connectionId, input.lease.stream, hash, (input.now ?? new Date()).toISOString()).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function saveCursor(db: AppDb, input: { connectionId: number; stream: 'people' | 'person_mergers'; nextUrl: string | null }): Promise<void> {
  await db.prepare(`INSERT INTO planning_center_sync_cursors(connection_id,stream,next_url) VALUES(?1,?2,?3)
    ON CONFLICT(connection_id,stream) DO UPDATE SET next_url=excluded.next_url,updated_at=CURRENT_TIMESTAMP`)
    .bind(input.connectionId, input.stream, input.nextUrl).run();
}

export async function failPlanningCenterSyncJob(db: AppDb, input: { lease: PlanningCenterSyncLease; code: string; retry?: boolean; retryAt?: number | null }): Promise<boolean> {
  if (!/^[a-z0-9_:-]{1,128}$/u.test(input.code)) throw new Error('planning_center_error_code_invalid');
  const hash = await sha256Utf8(`planning-center-lease:v1\0${input.lease.token}`);
  const notBefore = input.retryAt && Number.isFinite(input.retryAt) ? new Date(Math.max(Date.now(), input.retryAt)).toISOString() : null;
  const result = await db.prepare(`UPDATE planning_center_sync_jobs SET state=?1,last_error_code=?2,not_before=?3,lease_token_hash=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=?4 AND connection_id=?5 AND stream=?6 AND state='running' AND lease_token_hash=?7`)
    .bind(input.retry === false ? 'failed' : 'pending', input.code, notBefore, input.lease.jobId, input.lease.connectionId, input.lease.stream, hash).run();
  return (result.meta?.changes ?? 0) === 1;
}

function attributeString(attributes: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof attributes[key] === 'string' && attributes[key].trim()) return attributes[key] as string;
  return null;
}

function attributeBoolean(attributes: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => attributes[key] === true || attributes[key] === 1 || attributes[key] === 'true');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}

function relatedIncluded(page: PlanningCenterPage, row: PlanningCenterPage['data'][number], relationship: string, expectedType: string): PlanningCenterPage['included'] {
  const relation = row.relationships?.[relationship];
  const data = relation && typeof relation === 'object' && !Array.isArray(relation) ? (relation as { data?: unknown }).data : null;
  const ids = new Set(Array.isArray(data) ? data.map((item) => item && typeof item === 'object' && !Array.isArray(item)
    && (item as { type?: unknown }).type === expectedType && typeof (item as { id?: unknown }).id === 'string'
    ? `${expectedType}\0${(item as { id: string }).id}` : null).filter((id): id is string => id !== null) : []);
  return page.included.filter((item) => item.type === expectedType && ids.has(`${item.type}\0${item.id}`)).sort((left, right) => {
    const leftPrimary = attributeBoolean(left.attributes, 'primary', 'is_primary') ? 1 : 0;
    const rightPrimary = attributeBoolean(right.attributes, 'primary', 'is_primary') ? 1 : 0;
    return rightPrimary - leftPrimary || left.id.localeCompare(right.id);
  });
}

function selectedIncludedContact(page: PlanningCenterPage, row: PlanningCenterPage['data'][number], relationship: string, expectedType: string, keys: string[], ignoreBlocked: boolean): string | null {
  const candidates = relatedIncluded(page, row, relationship, expectedType)
    .filter((item) => !ignoreBlocked || (!attributeBoolean(item.attributes, 'blocked', 'is_blocked') && attributeString(item.attributes, 'status')?.toLowerCase() !== 'blocked'))
    .map((item) => attributeString(item.attributes, ...keys))
    .filter((value): value is string => value !== null);
  return candidates[0] ?? null;
}

async function campusScopedOwner(db: AppDb, campusId: number, owner: Awaited<ReturnType<typeof findVerifiedContactOwner>>): Promise<Awaited<ReturnType<typeof findVerifiedContactOwner>>> {
  if (!owner) return null;
  const member = await db.prepare(`SELECT 1 AS ok FROM campus_memberships WHERE campus_id=?1 AND person_id=?2 AND active=1`)
    .bind(campusId, owner.personId).first<{ ok: number }>();
  return member ? owner : null;
}

async function syncPerson(db: AppDb, env: PlanningCenterCredentialEnv, input: { connectionId: number; campusId: number; organizationId: string; page: PlanningCenterPage; row: PlanningCenterPage['data'][number] }): Promise<'created' | 'updated' | 'review' | 'unchanged'> {
  if (input.row.type !== 'Person') throw new Error('planning_center_person_shape_invalid');
  if (!/^[0-9]{1,32}$/u.test(input.row.id)) throw new Error('planning_center_provider_id_invalid');
  const attributes = input.row.attributes;
  const emailRelated = relatedIncluded(input.page, input.row, 'emails', 'Email');
  const phoneRelated = relatedIncluded(input.page, input.row, 'phone_numbers', 'PhoneNumber');
  const email = selectedIncludedContact(input.page, input.row, 'emails', 'Email', ['address', 'email'], true) ?? (emailRelated.length === 0 ? attributeString(attributes, 'email', 'primary_email') : null);
  const phone = selectedIncludedContact(input.page, input.row, 'phone_numbers', 'PhoneNumber', ['number', 'phone_number', 'phone'], false) ?? (phoneRelated.length === 0 ? attributeString(attributes, 'phone_number', 'phone') : null);
  const first = attributeString(attributes, 'first_name');
  const last = attributeString(attributes, 'last_name');
  const name = attributeString(attributes, 'name') ?? ([first, last].filter(Boolean).join(' ') || `Planning Center ${input.row.id}`);
  const normalizedEmail = email ? normalizeEmail(email) : null;
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const normalizedName = normalizeName(name);
  const payloadDigest = await sha256Utf8(JSON.stringify(canonicalize({ type: input.row.type, id: input.row.id, attributes, selected: { email: normalizedEmail, phone: normalizedPhone, name: normalizedName } })));
  const prior = await db.prepare(`SELECT person_id,match_state FROM planning_center_person_mappings WHERE connection_id=?1 AND provider_person_id=?2`)
    .bind(input.connectionId, input.row.id).first<{ person_id: number | null; match_state: string }>();
  const source = await registerIdentitySource(db, env, {
    campusId: input.campusId, source: 'planning_center', sourceRecordKey: `${input.organizationId}:${input.row.id}`,
    email: normalizedEmail, phone: normalizedPhone, name: normalizedName,
    attachmentPolicy: 'external_review', sourceDigest: payloadDigest,
  });
  const emailOwner = await campusScopedOwner(db, input.campusId, normalizedEmail ? await findVerifiedContactOwner(db, { kind: 'email', value: normalizedEmail }) : null);
  const phoneOwner = await campusScopedOwner(db, input.campusId, normalizedPhone ? await findVerifiedContactOwner(db, { kind: 'phone', value: normalizedPhone }) : null);
  const ownerConflict = emailOwner && phoneOwner && emailOwner.personId !== phoneOwner.personId;
  const personId = ownerConflict ? null : (emailOwner?.personId ?? phoneOwner?.personId ?? (prior?.match_state === 'matched' ? prior.person_id : null));
  const matchState = ownerConflict ? 'review' : personId ? 'matched' : normalizedEmail || normalizedPhone ? 'review' : (prior?.match_state === 'review' ? 'review' : 'unmatched');
  await db.prepare(`INSERT INTO planning_center_person_mappings(connection_id,provider_person_id,source_record_id,person_id,match_state,provider_updated_at)
    VALUES(?1,?2,?3,?4,?5,?6)
    ON CONFLICT(connection_id,provider_person_id) DO UPDATE SET source_record_id=excluded.source_record_id,
      person_id=CASE WHEN planning_center_person_mappings.person_id IS NULL THEN excluded.person_id
        WHEN excluded.person_id IS NULL OR planning_center_person_mappings.person_id=excluded.person_id THEN planning_center_person_mappings.person_id ELSE NULL END,
      match_state=CASE WHEN planning_center_person_mappings.person_id IS NOT NULL AND excluded.person_id IS NOT NULL
          AND planning_center_person_mappings.person_id<>excluded.person_id THEN 'review' ELSE excluded.match_state END,
      provider_updated_at=excluded.provider_updated_at,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(input.connectionId, input.row.id, source.sourceRecordId, personId, matchState, typeof attributes.updated_at === 'string' ? attributes.updated_at : null).run();
  const action = prior ? (prior.match_state === matchState && prior.person_id === personId ? 'unchanged' : 'updated') : 'created';
  const receiptId = await sha256Utf8(`planning-center-sync:v1\0${input.connectionId}\0${input.row.id}\0${payloadDigest}`);
  await db.prepare(`INSERT INTO planning_center_sync_receipts(receipt_id,connection_id,provider_person_id,source_record_id,source_version,source_digest,payload_digest,action)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(receipt_id) DO NOTHING`).bind(receiptId, input.connectionId, input.row.id, source.sourceRecordId, source.version, source.sourceDigest, payloadDigest, action).run();
  return matchState === 'review' ? 'review' : action;
}

export async function syncPlanningCenterPeoplePage(db: AppDb, env: PlanningCenterCredentialEnv, input: { connectionId: number; campusId: number; page: PlanningCenterPage }): Promise<{ processed: number; reviews: number }> {
  const connection = await db.prepare(`SELECT organization_id,campus_id FROM planning_center_connections WHERE id=?1`)
    .bind(input.connectionId).first<{ organization_id: string; campus_id: number }>();
  if (!connection || connection.campus_id !== input.campusId || !/^[0-9]{1,32}$/u.test(connection.organization_id)) throw new Error('planning_center_connection_scope_invalid');
  let reviews = 0;
  for (const row of input.page.data) {
    const action = await syncPerson(db, env, { ...input, organizationId: connection.organization_id, page: input.page, row });
    if (action === 'review') reviews += 1;
  }
  return { processed: input.page.data.length, reviews };
}

export async function markPlanningCenterPersonDeleted(db: AppDb, input: { connectionId: number; providerPersonId: string }): Promise<boolean> {
  if (!/^[0-9]{1,32}$/u.test(input.providerPersonId)) throw new Error('planning_center_provider_id_invalid');
  const mapping = await db.prepare(`SELECT source_record_id,source_version,source_digest,match_state FROM planning_center_person_mappings WHERE connection_id=?1 AND provider_person_id=?2`)
    .bind(input.connectionId, input.providerPersonId).first<{ source_record_id: number; source_version: number | null; source_digest: string | null; match_state: string }>();
  if (!mapping) return false;
  await db.prepare(`UPDATE planning_center_person_mappings SET person_id=NULL,match_state='deleted',updated_at=CURRENT_TIMESTAMP WHERE connection_id=?1 AND provider_person_id=?2`)
    .bind(input.connectionId, input.providerPersonId).run();
  const payloadDigest = await sha256Utf8(`planning-center-deleted:v1\0${input.connectionId}\0${input.providerPersonId}`);
  await db.prepare(`INSERT INTO planning_center_sync_receipts(receipt_id,connection_id,provider_person_id,source_record_id,source_version,source_digest,payload_digest,action)
    VALUES(?1,?2,?3,?4,?5,?6,?7,'deleted') ON CONFLICT(receipt_id) DO NOTHING`).bind(await sha256Utf8(`planning-center-delete-receipt:v1\0${input.connectionId}\0${input.providerPersonId}`), input.connectionId, input.providerPersonId, mapping.source_record_id, mapping.source_version, mapping.source_digest, payloadDigest).run();
  return mapping.match_state !== 'deleted';
}

export async function recordPlanningCenterMergerEvidence(db: AppDb, input: { connectionId: number; page: PlanningCenterPage }): Promise<number> {
  let recorded = 0;
  for (const row of input.page.data) {
    if (row.type !== 'PersonMerger' || !/^[\x21-\x7e]{1,256}$/u.test(row.id)) throw new Error('planning_center_merger_shape_invalid');
    const eventDigest = await sha256Utf8(JSON.stringify(canonicalize({ type: row.type, id: row.id, attributes: row.attributes })));
    const rawProviderPersonId = attributeString(row.attributes, 'person_to_keep_id');
    const rawProviderPersonRemoveId = attributeString(row.attributes, 'person_to_remove_id');
    const providerPersonId = rawProviderPersonId && /^[0-9]{1,32}$/u.test(rawProviderPersonId) ? rawProviderPersonId : null;
    const providerPersonRemoveId = rawProviderPersonRemoveId && /^[0-9]{1,32}$/u.test(rawProviderPersonRemoveId) ? rawProviderPersonRemoveId : null;
    let reviewCaseId: number | null = null;
    if (providerPersonId && providerPersonRemoveId && providerPersonId !== providerPersonRemoveId) {
      const keep = await db.prepare(`SELECT person_id FROM planning_center_person_mappings WHERE connection_id=?1 AND provider_person_id=?2 AND match_state='matched'`).bind(input.connectionId, providerPersonId).first<{ person_id: number | null }>();
      const remove = await db.prepare(`SELECT person_id FROM planning_center_person_mappings WHERE connection_id=?1 AND provider_person_id=?2 AND match_state='matched'`).bind(input.connectionId, providerPersonRemoveId).first<{ person_id: number | null }>();
      if (keep?.person_id && remove?.person_id && keep.person_id !== remove.person_id) {
        const personA = Math.min(keep.person_id, remove.person_id); const personB = Math.max(keep.person_id, remove.person_id);
        reviewCaseId = (await db.prepare(`SELECT id FROM identity_resolution_cases WHERE campus_id=(SELECT campus_id FROM planning_center_connections WHERE id=?1)
          AND person_a_id=?2 AND person_b_id=?3 AND state='open'`).bind(input.connectionId, personA, personB).first<{ id: number }>())?.id ?? null;
        if (reviewCaseId === null) {
          reviewCaseId = (await db.prepare(`INSERT INTO identity_resolution_cases(campus_id,person_a_id,person_b_id,score,evidence_json,risk)
            SELECT c.campus_id,?1,?2,60,?3,'high' FROM planning_center_connections c WHERE c.id=?4
            ON CONFLICT DO NOTHING RETURNING id`)
            .bind(personA, personB, JSON.stringify({ source: 'planning_center', externalEventId: row.id }), input.connectionId).first<{ id: number }>())?.id ?? null;
          if (reviewCaseId === null) reviewCaseId = (await db.prepare(`SELECT id FROM identity_resolution_cases WHERE campus_id=(SELECT campus_id FROM planning_center_connections WHERE id=?1)
            AND person_a_id=?2 AND person_b_id=?3 AND state='open'`).bind(input.connectionId, personA, personB).first<{ id: number }>())?.id ?? null;
        }
      }
    }
    const result = await db.prepare(`INSERT INTO planning_center_external_evidence(evidence_id,connection_id,provider_person_id,provider_person_remove_id,external_event_id,evidence_kind,event_digest,review_case_id)
      VALUES(?1,?2,?3,?4,?5,'person_merger',?6,?7) ON CONFLICT(evidence_id) DO NOTHING`).bind(await sha256Utf8(`planning-center-merger:v1\0${input.connectionId}\0${row.id}`), input.connectionId, providerPersonId, providerPersonRemoveId, row.id, eventDigest, reviewCaseId).run();
    recorded += (result.meta?.changes ?? 0);
  }
  return recorded;
}

/** Traffic-independent bounded sweeper. Webhooks/manual actions only enqueue durable jobs. */
export async function runPlanningCenterSyncPass(env: PlanningCenterCredentialEnv, db: AppDb, now = new Date()): Promise<{ claimed: number; completed: number; retried: number }> {
  let credentials: PlanningCenterCredentials;
  try { credentials = planningCenterCredentials(env); } catch (error) { if (error instanceof Error && error.message === 'planning_center_not_configured') return { claimed: 0, completed: 0, retried: 0 }; throw error; }
  const connections = await db.prepare(`SELECT c.id,c.campus_id,c.base_url,MIN(j.updated_at) AS oldest_due_job_at
      FROM planning_center_connections c
      JOIN planning_center_sync_jobs j ON j.connection_id=c.id
      WHERE c.state='active' AND (
        (j.state IN ('pending','failed') AND (j.not_before IS NULL OR j.not_before<=?1))
        OR (j.state='running' AND j.lease_until<=?1)
      )
      GROUP BY c.id,c.campus_id,c.base_url,c.last_success_at
      ORDER BY MIN(j.attempts),MIN(j.updated_at),CASE WHEN c.last_success_at IS NULL THEN 0 ELSE 1 END,c.last_success_at,c.id
      LIMIT ${PLANNING_CENTER_CONNECTION_BATCH_SIZE}`).bind(now.toISOString())
    .all<{ id: number; campus_id: number; base_url: string; oldest_due_job_at: string | Date }>();
  let claimed = 0; let completed = 0; let retried = 0;
  for (const connection of connections.results) {
    let connectionClaimed = 0;
    let connectionFailed = false;
    for (const stream of ['people', 'person_mergers'] as const) {
      await ensurePlanningCenterSyncJob(db, { connectionId: connection.id, stream });
      const lease = await claimPlanningCenterSyncJob(db, { connectionId: connection.id, stream, now });
      if (!lease) continue;
      claimed += 1;
      connectionClaimed += 1;
      const cursor = await db.prepare(`SELECT next_url FROM planning_center_sync_cursors WHERE connection_id=?1 AND stream=?2`)
        .bind(connection.id, stream).first<{ next_url: string | null }>();
      const jobCursor = await db.prepare(`SELECT cursor FROM planning_center_sync_jobs WHERE id=?1 AND state='running'`).bind(lease.jobId).first<{ cursor: string | null }>();
      const requestedPath = jobCursor?.cursor ?? cursor?.next_url ?? (stream === 'people' ? '/people/v2/people?include=emails,phone_numbers' : '/people/v2/person_mergers');
      const exactPerson = stream === 'people' && /^\/people\/v2\/people\/[0-9]{1,32}$/u.test(new URL(requestedPath, connection.base_url).pathname);
      try {
        const page = await fetchPlanningCenterPage({ baseUrl: connection.base_url, path: requestedPath, clientId: credentials.clientId, secret: credentials.secret, userAgent: credentials.userAgent });
        if (stream === 'people') await syncPlanningCenterPeoplePage(db, { ...env, ...credentials }, { connectionId: connection.id, campusId: connection.campus_id, page });
        else await recordPlanningCenterMergerEvidence(db, { connectionId: connection.id, page });
        const next = exactPerson ? (cursor?.next_url ?? '/people/v2/people?include=emails,phone_numbers') : nextPlanningCenterUrl(connection.base_url, page.links);
        const queuedRerun = await db.prepare(`SELECT rerun_requested FROM planning_center_sync_jobs WHERE id=?1 AND state='running'`).bind(lease.jobId).first<{ rerun_requested: number }>();
        if (await completePlanningCenterSyncJob(db, { lease, nextUrl: next, now })) {
          if (!queuedRerun?.rerun_requested) await saveCursor(db, { connectionId: connection.id, stream, nextUrl: next });
          completed += 1;
        } else { retried += 1; connectionFailed = true; }
      } catch (error) {
        connectionFailed = true;
        if (error instanceof PlanningCenterRateLimitError) { await failPlanningCenterSyncJob(db, { lease, code: 'rate_limited', retryAt: error.retryAt }); retried += 1; }
        else if (error instanceof PlanningCenterNotFoundError) {
          const exact = /^\/people\/v2\/people\/([0-9]{1,32})$/u.exec(new URL(requestedPath, connection.base_url).pathname);
          if (stream !== 'people' || !exact) { await failPlanningCenterSyncJob(db, { lease, code: 'not_found', retry: false }); retried += 1; }
          else {
            await markPlanningCenterPersonDeleted(db, { connectionId: connection.id, providerPersonId: exact[1] });
            const next = cursor?.next_url ?? '/people/v2/people?include=emails,phone_numbers';
            const queuedRerun = await db.prepare(`SELECT rerun_requested FROM planning_center_sync_jobs WHERE id=?1 AND state='running'`).bind(lease.jobId).first<{ rerun_requested: number }>();
            if (await completePlanningCenterSyncJob(db, { lease, nextUrl: next, now })) { if (!queuedRerun?.rerun_requested) await saveCursor(db, { connectionId: connection.id, stream, nextUrl: next }); completed += 1; }
            else retried += 1;
          }
        }
        else { await failPlanningCenterSyncJob(db, { lease, code: error instanceof Error && error.message === 'planning_center_next_invalid' ? 'cursor_invalid' : 'sync_failed', retry: false }); retried += 1; }
      }
    }
    if (connectionClaimed === 2 && !connectionFailed) {
      await db.prepare(`UPDATE planning_center_connections SET last_success_at=CURRENT_TIMESTAMP,last_error_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1`).bind(connection.id).run();
    } else if (connectionFailed) {
      await db.prepare(`UPDATE planning_center_connections SET last_error_code='sync_failed',updated_at=CURRENT_TIMESTAMP WHERE id=?1`).bind(connection.id).run();
    }
  }
  return { claimed, completed, retried };
}
