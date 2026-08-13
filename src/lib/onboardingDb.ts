import type { AppDb } from './appDb';
import type { SessionUser } from './types';
import {
  READINESS_CATALOG,
  READINESS_BY_ID,
  type ReadinessSeverity,
  type ReadinessStatus,
} from './readinessCatalog';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const RESTORE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type AcknowledgementRow = {
  check_id: string;
  actor_person_id: number;
  acknowledged_at: string;
  definition_version: number;
};

export type OnboardingReadinessItem = Readonly<{
  checkId: string;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  title: Readonly<{ en: string; zh: string }>;
  description: Readonly<{ en: string; zh: string }>;
  remediation: Readonly<{ en: string; zh: string }>;
  adminPath: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
}>;

function parseUtc(value: string): number {
  return Date.parse(value.replace(' ', 'T') + 'Z');
}

function assertNow(now: string): void {
  if (!TIMESTAMP.test(now) || !Number.isFinite(parseUtc(now))) throw new TypeError('onboarding timestamp is invalid');
}

function applicable(capabilities: readonly string[], enabled: ReadonlySet<string>): boolean {
  return capabilities.length === 0 || capabilities.every((key) => enabled.has(key));
}

function currentAcknowledgement(checkId: string, version: number, row: AcknowledgementRow | undefined, now: string): boolean {
  if (!row || row.definition_version !== version) return false;
  if (checkId !== 'restore-drill') return true;
  return parseUtc(now) - parseUtc(row.acknowledged_at) <= RESTORE_MAX_AGE_MS;
}

export async function listOnboardingReadiness(
  db: AppDb,
  enabledCapabilities: ReadonlySet<string>,
  now = new Date().toISOString().slice(0, 19).replace('T', ' '),
): Promise<OnboardingReadinessItem[]> {
  assertNow(now);
  const result = await db.prepare(`SELECT check_id,actor_person_id,acknowledged_at,definition_version
    FROM onboarding_acknowledgements ORDER BY check_id`).all<AcknowledgementRow>();
  const acknowledgements = new Map(result.results.map((row) => [row.check_id, row]));
  return READINESS_CATALOG.checks
    .filter((check) => check.surfaces.includes('admin'))
    .map((check) => {
      if (!applicable(check.selectors.capabilities, enabledCapabilities)) {
        return { checkId: check.id, status: 'not_applicable' as const, severity: check.severity, title: check.title,
          description: check.description, remediation: check.remediation, adminPath: check.adminPath,
          acknowledged: false, acknowledgedAt: null };
      }
      if (check.manualVersion === null) {
        return { checkId: check.id, status: 'action_required' as const, severity: check.severity, title: check.title,
          description: check.description, remediation: check.remediation, adminPath: check.adminPath,
          acknowledged: false, acknowledgedAt: null };
      }
      const row = acknowledgements.get(check.id);
      const acknowledged = currentAcknowledgement(check.id, check.manualVersion, row, now);
      return { checkId: check.id, status: acknowledged ? 'pass' as const : 'manual' as const,
        severity: check.severity, title: check.title, description: check.description,
        remediation: check.remediation, adminPath: check.adminPath, acknowledged,
        acknowledgedAt: acknowledged ? row!.acknowledged_at : null };
    });
}

export async function acknowledgeOnboardingCheck(
  db: AppDb,
  input: Readonly<{ checkId: string; actorPersonId: number; now?: string }>,
): Promise<void> {
  const definition = READINESS_BY_ID.get(input.checkId);
  if (!definition || !definition.surfaces.includes('admin') || definition.manualVersion === null) throw new TypeError('onboarding check is not manual');
  if (!Number.isSafeInteger(input.actorPersonId) || input.actorPersonId < 1) throw new TypeError('onboarding actor is invalid');
  const now = input.now ?? new Date().toISOString().slice(0, 19).replace('T', ' ');
  assertNow(now);
  await db.prepare(`INSERT INTO onboarding_acknowledgements
    (check_id,actor_person_id,acknowledged_at,definition_version) VALUES (?,?,?,?)
    ON CONFLICT(check_id) DO UPDATE SET actor_person_id=excluded.actor_person_id,
      acknowledged_at=excluded.acknowledged_at,definition_version=excluded.definition_version`)
    .bind(definition.id, input.actorPersonId, now, definition.manualVersion).run();
}

export function assertOnboardingReader(user: SessionUser | null): asserts user is SessionUser {
  if (!user?.isAdmin) throw new Error('onboarding_forbidden');
}

export function assertOnboardingAcknowledger(user: SessionUser | null): asserts user is SessionUser {
  if (!user?.isAdmin || !user.isSuperAdmin) throw new Error('onboarding_super_required');
}

export async function listOnboardingReadinessForUser(db: AppDb, user: SessionUser | null, enabled: ReadonlySet<string>, now?: string) {
  assertOnboardingReader(user);
  return listOnboardingReadiness(db, enabled, now);
}

export async function acknowledgeOnboardingCheckForUser(db: AppDb, user: SessionUser | null, checkId: string, now?: string): Promise<void> {
  assertOnboardingAcknowledger(user);
  return acknowledgeOnboardingCheck(db, { checkId, actorPersonId: user.id, now });
}
