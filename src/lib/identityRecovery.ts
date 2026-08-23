import type { AppDb, AppStatement } from './appDb';
import { canPerformSensitivePersonAction } from './adminDb';
import type { IdentityAuthEnv } from './identityAuth';
import { exactIdentityPersonCanonicalKeyStatement, refreshIdentityPersonCanonicalKeys } from './identityCanonical';
import { normalizeEmail } from './identityNormalize';
import { hmacIdentityRecoveryValue, identityRecoveryKeyMaterial, type IdentityRecoveryKeyEnv } from './identityRecoveryKey';
import { prepareIdentityRecoveryNotification } from './identityRecoveryOutbox';
import type { Locale } from './locales';
import type { SessionAssurance } from './sessionAssurance';

export const IDENTITY_RECOVERY_COOLING_HOURS = 24;
export type IdentityRecoveryEnv = IdentityAuthEnv & IdentityRecoveryKeyEnv & { IDENTITY_RECOVERY_COOLING_HOURS?: string };
const encoder = new TextEncoder();

type RecoveryCaseRow = {
  id: number;
  campus_id: number;
  person_id: number | null;
  contact_point_id: number;
  state: 'open' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  version: number;
  claimed_target_hash: string | null;
  source_operation_id: string | null;
  source_version: number;
  expires_at: string;
  normalized_value: string;
};

type TargetRow = {
  id: number;
  display_name: string;
  identity_version: number;
  session_epoch: number;
};

type HoldRow = {
  case_id: number;
  first_approver_person_id: number;
  expected_case_version: number;
  expected_person_id: number;
  expected_person_identity_version: number;
  expected_person_session_epoch: number;
  reachable_contact_point_id: number;
  expected_reachable_owner_person_id: number | null;
  expected_reachable_owner_generation: number;
  veto_key_id: string;
  not_before_at: string;
  expires_at: string;
};

type OwnerSnapshot = {
  contact_point_id: number;
  expected_owner_person_id: number | null;
  expected_generation: number;
  kind?: string;
  normalized_value?: string;
};

export type IdentityRecoveryTargetSummary = Readonly<{
  displayName: string;
  verifiedContactCategories: ReadonlyArray<Readonly<{ kind: string; count: number }>>;
  activeCampusCount: number;
  riskCategories: ReadonlyArray<'super_admin' | 'finance' | 'scoped_admin'>;
}>;

export type IdentityRecoveryView = Readonly<{
  id: number;
  campusId: number;
  personId: number | null;
  contactPointId: number;
  state: RecoveryCaseRow['state'];
  version: number;
  claimedTargetHash: string | null;
  sourceOperationId: string | null;
  sourceVersion: number;
  expiresAt: string;
  holding: boolean;
  notBeforeAt: string | null;
}>;

export type RecoveryApprovalResult =
  | Readonly<{ status: 'step_up_required' }>
  | Readonly<{ status: 'holding'; vetoToken: string; notBeforeAt: string; notifyOldContacts: string[] }>
  | Readonly<{ status: 'completed'; personId: number; sessionEpoch: number; notifyOldContacts: string[] }>
  | Readonly<{ status: 'blocked'; reason: 'target_required' | 'different_approver_required' | 'cooling_period' | 'vetoed' | 'expired' | 'already_resolved' | 'stale_review' | 'contact_conflict' | 'actor_ineligible' }>;

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function format(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function instant(value: string): Date {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime()) || format(date) !== value) throw new Error('identity_recovery_clock_invalid');
  return date;
}

function epochSeconds(value: string): number {
  return Math.floor(instant(value).getTime() / 1000);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomVetoToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function coolingHours(env: IdentityRecoveryEnv): number {
  if (env.IDENTITY_RECOVERY_COOLING_HOURS === undefined || env.IDENTITY_RECOVERY_COOLING_HOURS === '') {
    return IDENTITY_RECOVERY_COOLING_HOURS;
  }
  const value = Number(env.IDENTITY_RECOVERY_COOLING_HOURS);
  if (!Number.isSafeInteger(value) || value < IDENTITY_RECOVERY_COOLING_HOURS || value > 168) {
    throw new Error('identity_recovery_cooling_invalid');
  }
  return value;
}

async function caseRow(db: AppDb, campusId: number, caseId: number): Promise<RecoveryCaseRow | null> {
  return db.prepare(`SELECT c.id,c.campus_id,c.person_id,c.contact_point_id,c.state,c.version,c.claimed_target_hash,
      c.source_operation_id,c.source_version,c.expires_at,cp.normalized_value
    FROM identity_recovery_cases c JOIN contact_points cp ON cp.id=c.contact_point_id
    WHERE c.id=?1 AND c.campus_id=?2`).bind(caseId, campusId).first<RecoveryCaseRow>();
}

async function targetRow(db: AppDb, personId: number): Promise<TargetRow | null> {
  return db.prepare(`SELECT p.id,p.display_name,p.identity_version,p.session_epoch FROM people p
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
      AND p.auth_disabled_at IS NULL AND p.merged_into_person_id IS NULL AND r.loser_person_id IS NULL`)
    .bind(personId).first<TargetRow>();
}

async function holdRow(db: AppDb, caseId: number): Promise<HoldRow | null> {
  return db.prepare('SELECT * FROM identity_recovery_holds WHERE case_id=?1').bind(caseId).first<HoldRow>();
}

async function reachableState(db: AppDb, contactPointId: number): Promise<{ owner: number | null; generation: number; activeLinks: number; activeHouseholdLinks: number }> {
  const row = await db.prepare(`SELECT
      (SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1) owner,
      COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims WHERE contact_point_id=?1),0) generation,
      (SELECT COUNT(*) FROM person_contact_links WHERE contact_point_id=?1 AND ended_at IS NULL) active_links,
      (SELECT COUNT(*) FROM household_contact_links WHERE contact_point_id=?1 AND ended_at IS NULL) active_household_links`)
    .bind(contactPointId).first<{ owner: number | null; generation: number; active_links: number; active_household_links: number }>();
  if (!row) throw new Error('identity_recovery_state_unavailable');
  return { owner: row.owner, generation: row.generation, activeLinks: row.active_links, activeHouseholdLinks: row.active_household_links };
}

async function targetOwners(db: AppDb, personId: number): Promise<OwnerSnapshot[]> {
  const { results } = await db.prepare(`SELECT o.contact_point_id,o.person_id expected_owner_person_id,cp.kind,
      COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims m WHERE m.contact_point_id=o.contact_point_id),0) expected_generation,
      cp.normalized_value
    FROM verified_contact_owners o JOIN contact_points cp ON cp.id=o.contact_point_id
    WHERE o.person_id=?1 ORDER BY o.contact_point_id`).bind(personId).all<OwnerSnapshot>();
  return results;
}

function sameOwnerSnapshots(expected: OwnerSnapshot[], current: OwnerSnapshot[]): boolean {
  if (expected.length !== current.length) return false;
  return expected.every((left, index) => {
    const right = current[index];
    return left.contact_point_id === right?.contact_point_id
      && left.expected_owner_person_id === right.expected_owner_person_id
      && left.expected_generation === right.expected_generation;
  });
}

export async function getIdentityRecoveryCase(db: AppDb, campusId: number, caseId: number): Promise<IdentityRecoveryView | null> {
  if (!validId(campusId) || !validId(caseId)) return null;
  const [row, hold] = await Promise.all([caseRow(db, campusId, caseId), holdRow(db, caseId)]);
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    campusId: row.campus_id,
    personId: row.person_id,
    contactPointId: row.contact_point_id,
    state: row.state,
    version: row.version,
    claimedTargetHash: row.claimed_target_hash,
    sourceOperationId: row.source_operation_id,
    sourceVersion: row.source_version,
    expiresAt: row.expires_at,
    holding: Boolean(hold),
    notBeforeAt: hold?.not_before_at ?? null,
  });
}

export async function listOpenIdentityRecoveryCases(db: AppDb, campusId: number): Promise<IdentityRecoveryView[]> {
  if (!validId(campusId)) return [];
  const { results } = await db.prepare(`SELECT c.id,c.campus_id,c.person_id,c.contact_point_id,c.state,c.version,
      c.claimed_target_hash,c.source_operation_id,c.source_version,c.expires_at,cp.normalized_value,
      CASE WHEN h.case_id IS NULL THEN 0 ELSE 1 END holding,h.not_before_at
    FROM identity_recovery_cases c JOIN contact_points cp ON cp.id=c.contact_point_id
    LEFT JOIN identity_recovery_holds h ON h.case_id=c.id
    WHERE c.campus_id=?1 AND c.state='open' ORDER BY c.created_at,c.id`).bind(campusId).all<RecoveryCaseRow & { holding: number; not_before_at: string | null }>();
  return results.map((row) => Object.freeze({
    id: row.id, campusId: row.campus_id, personId: row.person_id, contactPointId: row.contact_point_id,
    state: row.state, version: row.version, claimedTargetHash: row.claimed_target_hash,
    sourceOperationId: row.source_operation_id, sourceVersion: row.source_version, expiresAt: row.expires_at,
    holding: row.holding === 1, notBeforeAt: row.not_before_at,
  }));
}

export async function listAllOpenIdentityRecoveryCases(db: AppDb): Promise<IdentityRecoveryView[]> {
  const campusRows = await db.prepare("SELECT DISTINCT campus_id FROM identity_recovery_cases WHERE state='open' ORDER BY campus_id")
    .all<{ campus_id: number }>();
  const nested = await Promise.all(campusRows.results.map((row) => listOpenIdentityRecoveryCases(db, row.campus_id)));
  return nested.flat().sort((left, right) => left.id - right.id);
}

/** Current verified target mailboxes used only for security notifications. */
export async function listIdentityRecoveryOldContacts(db: AppDb, campusId: number, caseId: number): Promise<string[]> {
  const row = await caseRow(db, campusId, caseId);
  if (!row?.person_id) return [];
  return (await targetOwners(db, row.person_id)).filter((owner) => owner.kind === 'email').map((owner) => owner.normalized_value!).filter(Boolean);
}

export async function getIdentityRecoveryTargetSummary(db: AppDb, campusId: number, caseId: number): Promise<IdentityRecoveryTargetSummary | null> {
  if (!validId(campusId) || !validId(caseId)) return null;
  const person = await db.prepare(`SELECT p.display_name,p.super_admin,p.finance,p.admin_areas,
      (SELECT COUNT(*) FROM campus_memberships cm WHERE cm.person_id=p.id AND cm.active=1) active_campus_count
    FROM identity_recovery_cases c JOIN people p ON p.id=c.person_id
    WHERE c.id=?1 AND c.campus_id=?2 AND p.active=1 AND p.deleted_at IS NULL`)
    .bind(caseId, campusId).first<{ display_name: string; super_admin: number; finance: number; admin_areas: string; active_campus_count: number }>();
  if (!person) return null;
  const contacts = await db.prepare(`SELECT cp.kind,COUNT(*) count FROM verified_contact_owners o
    JOIN contact_points cp ON cp.id=o.contact_point_id JOIN identity_recovery_cases c ON c.person_id=o.person_id
    WHERE c.id=?1 AND c.campus_id=?2 GROUP BY cp.kind ORDER BY cp.kind`).bind(caseId, campusId).all<{ kind: string; count: number }>();
  const riskCategories: Array<'super_admin' | 'finance' | 'scoped_admin'> = [];
  if (person.super_admin === 1) riskCategories.push('super_admin');
  if (person.finance === 1) riskCategories.push('finance');
  if (person.admin_areas.trim()) riskCategories.push('scoped_admin');
  return Object.freeze({
    displayName: person.display_name,
    verifiedContactCategories: contacts.results.map((row) => Object.freeze({ kind: row.kind, count: row.count })),
    activeCampusCount: person.active_campus_count,
    riskCategories: Object.freeze(riskCategories),
  });
}

async function actorEligible(db: AppDb, actorPersonId: number, assurance: SessionAssurance | null, now: string): Promise<boolean> {
  return validId(actorPersonId) && canPerformSensitivePersonAction(db, actorPersonId, assurance, epochSeconds(now));
}

export async function approveIdentityRecovery(db: AppDb, env: IdentityRecoveryEnv, input: Readonly<{
  campusId: number;
  caseId: number;
  actorPersonId: number;
  assurance: SessionAssurance | null;
  now: string;
  targetPersonId?: number;
  notificationLocale?: Locale;
}>): Promise<RecoveryApprovalResult> {
  if (!validId(input.campusId) || !validId(input.caseId) || !validId(input.actorPersonId)) {
    return { status: 'blocked', reason: 'actor_ineligible' };
  }
  const nowDate = instant(input.now);
  if (!await actorEligible(db, input.actorPersonId, input.assurance, input.now)) return { status: 'step_up_required' };
  let recovery = await caseRow(db, input.campusId, input.caseId);
  if (!recovery) return { status: 'blocked', reason: 'already_resolved' };
  if (recovery.state !== 'open') {
    const veto = await db.prepare("SELECT 1 ok FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'").bind(recovery.id).first<number>('ok');
    return veto === 1 ? { status: 'blocked', reason: 'vetoed' } : { status: 'blocked', reason: 'already_resolved' };
  }
  if (recovery.expires_at <= input.now) return { status: 'blocked', reason: 'expired' };

  const existingHold = await holdRow(db, recovery.id);
  if (!existingHold) {
    const selectedTarget = recovery.person_id ?? (validId(input.targetPersonId) ? input.targetPersonId : null);
    if (selectedTarget === null) return { status: 'blocked', reason: 'target_required' };
    if (recovery.person_id === null) {
      const bound = await db.prepare(`UPDATE identity_recovery_cases SET person_id=?1,version=version+1
        WHERE id=?2 AND campus_id=?3 AND state='open' AND person_id IS NULL AND version=?4`)
        .bind(selectedTarget, recovery.id, recovery.campus_id, recovery.version).run();
      if (bound.meta.changes !== 1) return { status: 'blocked', reason: 'stale_review' };
      recovery = await caseRow(db, input.campusId, input.caseId);
      if (!recovery) return { status: 'blocked', reason: 'stale_review' };
    }
    const target = await targetRow(db, selectedTarget);
    if (!target || recovery.person_id !== selectedTarget) return { status: 'blocked', reason: 'stale_review' };
    const reachable = await reachableState(db, recovery.contact_point_id);
    if (reachable.owner !== null || reachable.activeLinks !== 0 || reachable.activeHouseholdLinks !== 0) return { status: 'blocked', reason: 'contact_conflict' };
    const oldOwners = await targetOwners(db, target.id);
    if (oldOwners.length === 0) return { status: 'blocked', reason: 'stale_review' };
    const reviewedCase = recovery;

    const recoveryKey = await identityRecoveryKeyMaterial(db, env);
    const vetoToken = randomVetoToken();
    const vetoHash = await hmacIdentityRecoveryValue(recoveryKey, 'veto-token', vetoToken);
    const notBefore = new Date(nowDate.getTime() + coolingHours(env) * 60 * 60_000);
    const notBeforeAt = format(notBefore);
    const holdExpiresAt = recovery.expires_at;
    if (holdExpiresAt < notBeforeAt) return { status: 'blocked', reason: 'expired' };
    const decisionId = crypto.randomUUID();
    const noticeStatements = (await Promise.all(oldOwners.filter((owner) => owner.kind === 'email' && owner.normalized_value)
      .map((owner) => prepareIdentityRecoveryNotification(db, env, {
        caseId: reviewedCase.id, category: 'hold_old_contact', contactPointId: owner.contact_point_id,
        recipient: owner.normalized_value!, locale: input.notificationLocale ?? 'en', vetoToken,
      })))).filter((statement): statement is AppStatement => statement !== null);
    const statements: AppStatement[] = [
      db.prepare(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,
          expected_person_id,expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_person_id,
          expected_reachable_owner_generation,created_at)
        VALUES(?1,?2,'first_approval',?3,?4,?5,?6,?7,?8,?9,?10)`)
        .bind(decisionId, reviewedCase.id, input.actorPersonId, reviewedCase.version, target.id, target.identity_version,
          target.session_epoch, reachable.owner, reachable.generation, input.now),
      ...oldOwners.map((owner) => db.prepare(`INSERT INTO identity_recovery_owner_snapshots
        (case_id,contact_point_id,snapshot_role,expected_owner_person_id,expected_generation,created_at)
        VALUES(?1,?2,'target_auth',?3,?4,?5)`).bind(reviewedCase.id, owner.contact_point_id, owner.expected_owner_person_id, owner.expected_generation, input.now)),
      db.prepare(`INSERT INTO identity_recovery_owner_snapshots
        (case_id,contact_point_id,snapshot_role,expected_owner_person_id,expected_generation,created_at)
        VALUES(?1,?2,'reachable',?3,?4,?5)`).bind(reviewedCase.id, reviewedCase.contact_point_id, reachable.owner, reachable.generation, input.now),
      db.prepare(`INSERT INTO identity_recovery_holds(case_id,first_decision_id,first_approver_person_id,expected_case_version,
          expected_person_id,expected_person_identity_version,expected_person_session_epoch,reachable_contact_point_id,
          expected_reachable_owner_person_id,expected_reachable_owner_generation,veto_key_id,veto_token_hash,not_before_at,expires_at,created_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`)
        .bind(reviewedCase.id, decisionId, input.actorPersonId, reviewedCase.version, target.id, target.identity_version, target.session_epoch,
          reviewedCase.contact_point_id, reachable.owner, reachable.generation, recoveryKey.keyId, vetoHash, notBeforeAt, holdExpiresAt, input.now),
      db.prepare(`UPDATE identity_recovery_cases SET reviewer_person_id=?1,version=version+1
        WHERE id=?2 AND state='open' AND version=?3`).bind(input.actorPersonId, reviewedCase.id, reviewedCase.version),
      ...noticeStatements,
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,actor_person_id,subject_person_id,contact_point_id,metadata_json)
        VALUES(?1,'identity_recovery_first_approved',?2,?3,?4,?5)`).bind(reviewedCase.campus_id, input.actorPersonId,
          target.id, reviewedCase.contact_point_id, JSON.stringify({ caseId: reviewedCase.id, sourceVersion: reviewedCase.source_version })),
    ];
    try {
      await db.batch(statements);
    } catch {
      return { status: 'blocked', reason: 'stale_review' };
    }
    return { status: 'holding', vetoToken, notBeforeAt, notifyOldContacts: oldOwners.filter((owner) => owner.kind === 'email').map((owner) => owner.normalized_value!).filter(Boolean) };
  }

  if (existingHold.first_approver_person_id === input.actorPersonId) return { status: 'blocked', reason: 'different_approver_required' };
  const veto = await db.prepare("SELECT 1 ok FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'").bind(recovery.id).first<number>('ok');
  if (veto === 1) return { status: 'blocked', reason: 'vetoed' };
  if (input.now < existingHold.not_before_at) return { status: 'blocked', reason: 'cooling_period' };
  if (input.now >= existingHold.expires_at) return { status: 'blocked', reason: 'expired' };

  if (recovery.person_id !== existingHold.expected_person_id
    || recovery.contact_point_id !== existingHold.reachable_contact_point_id) {
    return { status: 'blocked', reason: 'stale_review' };
  }

  const target = await targetRow(db, existingHold.expected_person_id);
  if (!target || target.identity_version !== existingHold.expected_person_identity_version
    || target.session_epoch !== existingHold.expected_person_session_epoch || recovery.version !== existingHold.expected_case_version + 1) {
    return { status: 'blocked', reason: 'stale_review' };
  }
  const reachable = await reachableState(db, existingHold.reachable_contact_point_id);
  if (reachable.owner !== existingHold.expected_reachable_owner_person_id
    || reachable.generation !== existingHold.expected_reachable_owner_generation || reachable.activeLinks !== 0 || reachable.activeHouseholdLinks !== 0) {
    return { status: 'blocked', reason: 'contact_conflict' };
  }
  const { results: snapshots } = await db.prepare(`SELECT contact_point_id,expected_owner_person_id,expected_generation
    FROM identity_recovery_owner_snapshots WHERE case_id=?1 AND snapshot_role='target_auth' ORDER BY contact_point_id`)
    .bind(recovery.id).all<OwnerSnapshot>();
  const currentOwners = await targetOwners(db, target.id);
  if (!sameOwnerSnapshots(snapshots, currentOwners)) return { status: 'blocked', reason: 'stale_review' };
  const normalizedReachable = normalizeEmail(recovery.normalized_value);
  if (normalizedReachable !== recovery.normalized_value) return { status: 'blocked', reason: 'contact_conflict' };
  const canonicalRegistry = await refreshIdentityPersonCanonicalKeys(db);
  if (!canonicalRegistry.complete || canonicalRegistry.failed) return { status: 'blocked', reason: 'contact_conflict' };
  const canonicalCollision = await db.prepare(`SELECT 1 ok FROM identity_person_canonical_keys key
    JOIN people person ON person.id=key.person_id
    WHERE key.person_id<>?1 AND person.deleted_at IS NULL AND key.normalization_version=1
      AND key.is_current=1 AND key.legacy_email_key=?2 LIMIT 1`)
    .bind(target.id, normalizedReachable).first<number>('ok');
  if (canonicalCollision === 1) return { status: 'blocked', reason: 'contact_conflict' };
  const collision = await db.prepare('SELECT 1 ok FROM people WHERE id<>?1 AND deleted_at IS NULL AND lower(email)=?2 LIMIT 1')
    .bind(target.id, recovery.normalized_value).first<number>('ok');
  if (collision === 1) return { status: 'blocked', reason: 'contact_conflict' };

  const completionNotices = (await Promise.all(currentOwners.filter((owner) => owner.kind === 'email' && owner.normalized_value)
    .map((owner) => prepareIdentityRecoveryNotification(db, env, {
      caseId: recovery.id, category: 'completed_old_contact', contactPointId: owner.contact_point_id,
      recipient: owner.normalized_value!, locale: input.notificationLocale ?? 'en',
    })))).filter((statement): statement is AppStatement => statement !== null);
  const decisionId = crypto.randomUUID();
  const statements: AppStatement[] = [
    db.prepare(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,
        expected_person_id,expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_person_id,
        expected_reachable_owner_generation,created_at)
      VALUES(?1,?2,'second_approval',?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(decisionId, recovery.id, input.actorPersonId, recovery.version, target.id, target.identity_version,
        target.session_epoch, reachable.owner, reachable.generation, input.now),
  ];
  for (const owner of snapshots) {
    statements.push(db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      VALUES(?1,?2,?3,NULL,'revoke')`).bind(owner.contact_point_id, owner.expected_generation + 1, target.id));
    statements.push(db.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1 AND person_id=?2')
      .bind(owner.contact_point_id, target.id));
    statements.push(db.prepare(`UPDATE person_contact_links SET is_primary=0,notification_enabled=1
      WHERE person_id=?1 AND contact_point_id=?2 AND ended_at IS NULL`).bind(target.id, owner.contact_point_id));
    statements.push(db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,actor_person_id,reason)
      VALUES(?1,NULL,?2,'revoked',?3,NULL)`).bind(owner.contact_point_id, target.id, input.actorPersonId));
  }
  statements.push(
    db.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled)
      VALUES(?1,?2,'email','recovery_review',1,1)`).bind(target.id, recovery.contact_point_id),
    db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      VALUES(?1,?2,NULL,?3,'assign')`).bind(recovery.contact_point_id, reachable.generation + 1, target.id),
    db.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method)
      VALUES(?1,?2,'admin_review')`).bind(recovery.contact_point_id, target.id),
    db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,actor_person_id,reason)
      VALUES(?1,?2,NULL,'verified',?3,NULL)`).bind(recovery.contact_point_id, target.id, input.actorPersonId),
    db.prepare(`UPDATE people SET email=?1,session_epoch=session_epoch+1,identity_version=identity_version+1,updated_at=?2
      WHERE id=?3 AND session_epoch=?4 AND identity_version=?5 AND active=1 AND deleted_at IS NULL
        AND identity_state='active' AND auth_disabled_at IS NULL AND merged_into_person_id IS NULL`)
      .bind(recovery.normalized_value, input.now, target.id, target.session_epoch, target.identity_version),
    exactIdentityPersonCanonicalKeyStatement(db, { personId: target.id, email: recovery.normalized_value, displayName: target.display_name }),
    db.prepare(`UPDATE identity_challenges SET superseded_at=?1 WHERE person_id=?2 AND superseded_at IS NULL`).bind(input.now, target.id),
    db.prepare(`UPDATE tokens SET used_at=?1 WHERE person_id=?2 AND used_at IS NULL`).bind(input.now, target.id),
    db.prepare(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,
        expected_person_id,expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_person_id,
        expected_reachable_owner_generation,created_at)
      VALUES(?1,?2,'executed',?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(crypto.randomUUID(), recovery.id, input.actorPersonId, recovery.version, target.id, target.identity_version,
        target.session_epoch, reachable.owner, reachable.generation, input.now),
    ...completionNotices,
    db.prepare(`UPDATE identity_recovery_cases SET state='approved',version=version+1,resolved_at=?1,resolution='two_person_recovery'
      WHERE id=?2 AND state='open' AND version=?3`).bind(input.now, recovery.id, recovery.version),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,actor_person_id,subject_person_id,contact_point_id,metadata_json)
      VALUES(?1,'identity_recovery_completed',?2,?3,?4,?5)`).bind(recovery.campus_id, input.actorPersonId, target.id,
        recovery.contact_point_id, JSON.stringify({ caseId: recovery.id, sourceVersion: recovery.source_version, ownerPolicy: 'replaceAuthOwners' })),
  );
  try {
    await db.batch(statements);
  } catch {
    return { status: 'blocked', reason: 'stale_review' };
  }
  return {
    status: 'completed',
    personId: target.id,
    sessionEpoch: target.session_epoch + 1,
    notifyOldContacts: currentOwners.filter((owner) => owner.kind === 'email').map((owner) => owner.normalized_value!).filter(Boolean),
  };
}

async function vetoHoldByToken(db: AppDb, env: IdentityRecoveryKeyEnv, token: string): Promise<HoldRow | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token) || encoder.encode(token).byteLength !== 43) return null;
  const recoveryKey = await identityRecoveryKeyMaterial(db, env);
  const hash = await hmacIdentityRecoveryValue(recoveryKey, 'veto-token', token);
  return db.prepare('SELECT * FROM identity_recovery_holds WHERE veto_key_id=?1 AND veto_token_hash=?2')
    .bind(recoveryKey.keyId, hash).first<HoldRow>();
}

export async function peekIdentityRecoveryVeto(db: AppDb, env: IdentityRecoveryKeyEnv, token: string, now: string): Promise<{ valid: boolean }> {
  instant(now);
  const hold = await vetoHoldByToken(db, env, token);
  if (!hold || now >= hold.expires_at) return { valid: false };
  const row = await db.prepare(`SELECT c.state,
      EXISTS(SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=c.id AND d.decision IN ('second_approval','executed')) executed
    FROM identity_recovery_cases c WHERE c.id=?1`).bind(hold.case_id).first<{ state: string; executed: number }>();
  return { valid: row?.state === 'open' && row.executed !== 1 };
}

export async function vetoIdentityRecovery(db: AppDb, env: IdentityRecoveryKeyEnv, token: string, now: string): Promise<{ vetoed: boolean }> {
  instant(now);
  const hold = await vetoHoldByToken(db, env, token);
  if (!hold) return { vetoed: false };
  const existing = await db.prepare("SELECT 1 ok FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'").bind(hold.case_id).first<number>('ok');
  if (existing === 1) return { vetoed: true };
  if (now >= hold.expires_at) return { vetoed: false };
  try {
    await db.batch([
      db.prepare(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,
          expected_person_id,expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_person_id,
          expected_reachable_owner_generation,created_at)
        VALUES(?1,?2,'veto',NULL,?3,?4,?5,?6,?7,?8,?9)`).bind(crypto.randomUUID(), hold.case_id,
          hold.expected_case_version + 1, hold.expected_person_id, hold.expected_person_identity_version,
          hold.expected_person_session_epoch, hold.expected_reachable_owner_person_id, hold.expected_reachable_owner_generation, now),
      db.prepare(`UPDATE identity_recovery_cases SET state='rejected',resolution='veto',resolved_at=?1,version=version+1
        WHERE id=?2 AND state='open' AND version=?3`).bind(now, hold.case_id, hold.expected_case_version + 1),
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
        SELECT campus_id,'identity_recovery_vetoed',person_id,contact_point_id,?1 FROM identity_recovery_cases WHERE id=?2`)
        .bind(JSON.stringify({ caseId: hold.case_id }), hold.case_id),
    ]);
  } catch {
    return { vetoed: (await db.prepare("SELECT 1 ok FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'").bind(hold.case_id).first<number>('ok')) === 1 };
  }
  return { vetoed: true };
}
