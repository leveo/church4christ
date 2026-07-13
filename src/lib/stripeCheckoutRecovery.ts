import type { AppDb } from './appDb';
import type { DbEnv } from './dbProvider';
import { openDb } from './dbProvider';
import {
  applyClaimedRegistrationCheckoutSession,
  attachClaimedRegistrationCheckoutSessionId,
  cancelClaimedRegistrationCheckoutRequest,
  type RegistrationCheckoutAction,
} from './regDb';
import {
  createRegistrationCheckoutFromParams,
  requireRegistrationCheckoutSession,
  retrieveCheckoutSession,
  StripeError,
  type StripeCheckoutSession,
  type StripeEnv,
} from './stripe';
import {
  claimRegistrationCheckoutRequest,
  listDueRegistrationCheckoutRequestIds,
  markClaimedRegistrationCheckoutManualReview,
  parseCheckoutRequestId,
  releaseRegistrationCheckoutRecoveryClaim,
  registrationCheckoutClaimIsCurrent,
  scheduleClaimedRegistrationCheckoutRequest,
  type RegistrationCheckoutRecoveryClaim,
} from './stripeCheckoutRequests';

const CHECKPOINT_MINUTES = [45, 90, 180, 480, 960, 1425] as const;
const CREATE_CUTOFF_MS = 24 * 60 * 60_000;
const CLAIM_MS = 10 * 60_000;
const ATTACHED_RETRY_MS = 24 * 60 * 60_000;

type OpenedDb = ReturnType<typeof openDb>;

export interface StripeCheckoutRecoveryDeps {
  env: StripeEnv & DbEnv;
  openDb?: (env: StripeEnv & DbEnv) => OpenedDb;
  now?: () => Date;
  createCheckout?: typeof createRegistrationCheckoutFromParams;
  retrieveCheckout?: typeof retrieveCheckoutSession;
  limit?: number;
}

export type StripeCheckoutRecoveryResult =
  | { requestId: string; state: 'confirmed' | 'cancelled' | 'attached' | 'scheduled' | 'manual_review' }
  | { requestId: string; state: 'not_claimed' };

const toDbTime = (date: Date): string => date.toISOString().replace('T', ' ').replace('Z', '');
const addMs = (date: Date, milliseconds: number): Date => new Date(date.getTime() + milliseconds);

function parseDbTime(value: string): Date {
  const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('checkout_recovery_time_invalid');
  return parsed;
}

function claimVersion(now: Date): string {
  return toDbTime(now);
}

function boundedError(error: unknown): string {
  if (error instanceof StripeError) {
    const detail = error.code ?? (error.status === undefined ? 'unknown' : String(error.status));
    return `stripe_${error.stage}_${detail}`.slice(0, 1000);
  }
  return 'checkout_recovery_failed';
}

function expectedSession(claim: RegistrationCheckoutRecoveryClaim, sessionId?: string) {
  return {
    requestId: claim.requestId,
    registrationId: claim.registrationId,
    amountCents: claim.amountCents,
    currency: claim.currency,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function nextCreateCheckpoint(createdAt: Date, now: Date): Date | null {
  const age = now.getTime() - createdAt.getTime();
  const next = CHECKPOINT_MINUTES.find((minutes) => minutes * 60_000 > age);
  return next === undefined ? null : addMs(createdAt, next * 60_000);
}

async function claim(
  db: AppDb,
  requestId: string,
  now: Date,
  force: boolean,
  actorId: number | null,
  allowUnattachedManualReview = false,
): Promise<RegistrationCheckoutRecoveryClaim | null> {
  return claimRegistrationCheckoutRequest(db, requestId, {
    now: toDbTime(now),
    claimExpiresAt: toDbTime(addMs(now, CLAIM_MS)),
    claimVersion: claimVersion(now),
    force,
    actorId,
    allowUnattachedManualReview,
  });
}

async function scheduleAmbiguous(
  db: AppDb,
  claimRow: RegistrationCheckoutRecoveryClaim,
  now: Date,
  error: unknown,
  actorId: number | null,
): Promise<StripeCheckoutRecoveryResult> {
  const diagnostic = boundedError(error);
  if (claimRow.state === 'creating') {
    const next = nextCreateCheckpoint(parseDbTime(claimRow.createdAt), now);
    if (next === null) {
      const updated = await markClaimedRegistrationCheckoutManualReview(db, claimRow, {
        error: diagnostic === 'checkout_recovery_failed' ? 'checkout_creation_ambiguous' : diagnostic,
        actorId,
        updatedAt: toDbTime(addMs(now, 2)),
      });
      return { requestId: claimRow.requestId, state: updated ? 'manual_review' : 'not_claimed' };
    }
    const updated = await scheduleClaimedRegistrationCheckoutRequest(db, claimRow, {
      nextAt: toDbTime(next),
      error: diagnostic,
      updatedAt: toDbTime(addMs(now, 2)),
    });
    return { requestId: claimRow.requestId, state: updated ? 'scheduled' : 'not_claimed' };
  }
  const updated = await scheduleClaimedRegistrationCheckoutRequest(db, claimRow, {
    nextAt: toDbTime(addMs(now, ATTACHED_RETRY_MS)),
    error: diagnostic,
    updatedAt: toDbTime(addMs(now, 2)),
  });
  return { requestId: claimRow.requestId, state: updated ? 'scheduled' : 'not_claimed' };
}

function recoveryAction(session: StripeCheckoutSession): RegistrationCheckoutAction | null {
  if (session.payment_status === 'paid') return 'confirm';
  if (session.status === 'expired') return 'cancel';
  if (session.status === 'open') return 'attach_open';
  if (session.status === 'complete') return 'attach_waiting';
  return null;
}

async function applySession(
  db: AppDb,
  claimRow: RegistrationCheckoutRecoveryClaim,
  session: StripeCheckoutSession,
  now: Date,
  actorId: number | null,
): Promise<StripeCheckoutRecoveryResult> {
  const action = recoveryAction(session);
  if (!action || (action === 'attach_open' && session.url === null)) {
    return scheduleAmbiguous(db, claimRow, now, new Error('checkout_session_unresolved'), actorId);
  }
  if (!(await registrationCheckoutClaimIsCurrent(db, claimRow))) {
    return { requestId: claimRow.requestId, state: 'not_claimed' };
  }
  const applied = await applyClaimedRegistrationCheckoutSession(db, {
    requestId: claimRow.requestId,
    registrationId: claimRow.registrationId,
    claimedState: claimRow.state,
    claimVersion: claimRow.claimVersion,
    sessionId: session.id,
    paymentIntentId: action === 'confirm' ? session.payment_intent : null,
    amountCents: claimRow.amountCents,
    currency: claimRow.currency,
    action,
    sessionUrl: action === 'attach_open' ? session.url : null,
    nextReconcileAt: action === 'attach_open' || action === 'attach_waiting'
      ? toDbTime(addMs(now, ATTACHED_RETRY_MS))
      : null,
    actorId,
    updatedAt: toDbTime(addMs(now, 2)),
  });
  if (!applied) return { requestId: claimRow.requestId, state: 'not_claimed' };
  return {
    requestId: claimRow.requestId,
    state: action === 'confirm'
      ? 'confirmed'
      : action === 'cancel'
        ? 'cancelled'
        : 'attached',
  };
}

async function processClaim(
  deps: StripeCheckoutRecoveryDeps,
  db: AppDb,
  claimRow: RegistrationCheckoutRecoveryClaim,
  now: Date,
  actorId: number | null,
): Promise<StripeCheckoutRecoveryResult> {
  const createCheckout = deps.createCheckout ?? createRegistrationCheckoutFromParams;
  const retrieveCheckout = deps.retrieveCheckout ?? retrieveCheckoutSession;
  let activeClaim = claimRow;
  try {
    if (activeClaim.requestInvalid) {
      return scheduleAmbiguous(db, activeClaim, now, new Error('checkout_request_invalid'), actorId);
    }
    let sessionId = activeClaim.sessionId;
    if (activeClaim.state === 'creating') {
      const age = now.getTime() - parseDbTime(activeClaim.createdAt).getTime();
      if (age >= CREATE_CUTOFF_MS || activeClaim.requestJson === null) {
        return scheduleAmbiguous(db, activeClaim, now, new Error('checkout_create_window_closed'), actorId);
      }
      if (!(await registrationCheckoutClaimIsCurrent(db, activeClaim))) {
        return { requestId: activeClaim.requestId, state: 'not_claimed' };
      }
      const createdRaw = await createCheckout(deps.env, activeClaim.requestJson, { requestId: activeClaim.requestId });
      const created = requireRegistrationCheckoutSession(createdRaw, expectedSession(activeClaim));
      sessionId = created.id;
      const attachedVersion = toDbTime(addMs(now, 1));
      const nextReconcileAt = toDbTime(addMs(now, ATTACHED_RETRY_MS));
      const attached = await attachClaimedRegistrationCheckoutSessionId(db, {
        requestId: activeClaim.requestId,
        registrationId: activeClaim.registrationId,
        claimVersion: activeClaim.claimVersion,
        sessionId,
        amountCents: activeClaim.amountCents,
        currency: activeClaim.currency,
        nextReconcileAt,
        updatedAt: attachedVersion,
      });
      if (!attached) return { requestId: activeClaim.requestId, state: 'not_claimed' };
      activeClaim = {
        ...activeClaim,
        state: 'attached',
        requestJson: null,
        sessionId,
        claimVersion: attachedVersion,
        previousNextReconcileAt: nextReconcileAt,
        requestInvalid: false,
      };
    }
    if (sessionId === null) return scheduleAmbiguous(db, activeClaim, now, new Error('checkout_session_missing'), actorId);
    if (!(await registrationCheckoutClaimIsCurrent(db, activeClaim))) {
      return { requestId: activeClaim.requestId, state: 'not_claimed' };
    }
    const retrievedRaw = await retrieveCheckout(deps.env, sessionId, {});
    const retrieved = requireRegistrationCheckoutSession(retrievedRaw, expectedSession(activeClaim, sessionId));
    return applySession(db, activeClaim, retrieved, now, actorId);
  } catch (error) {
    return scheduleAmbiguous(db, activeClaim, now, error, actorId);
  }
}

async function processRequest(
  deps: StripeCheckoutRecoveryDeps,
  requestIdValue: string,
  options: { force: boolean; actorId: number | null },
): Promise<StripeCheckoutRecoveryResult> {
  const requestId = parseCheckoutRequestId(requestIdValue);
  const opened = (deps.openDb ?? openDb)(deps.env);
  try {
    if (opened.backend !== 'supabase') return { requestId, state: 'not_claimed' };
    const now = (deps.now ?? (() => new Date()))();
    const claimed = await claim(opened.db, requestId, now, options.force, options.actorId);
    if (!claimed) return { requestId, state: 'not_claimed' };
    return processClaim(deps, opened.db, claimed, now, options.actorId);
  } finally {
    await opened.end();
  }
}

/** List due IDs once, then process each through a fresh database handle sequentially. */
export async function drainStripeCheckoutRecovery(
  deps: StripeCheckoutRecoveryDeps,
): Promise<StripeCheckoutRecoveryResult[]> {
  const opened = (deps.openDb ?? openDb)(deps.env);
  let ids: string[];
  try {
    if (opened.backend !== 'supabase') return [];
    ids = await listDueRegistrationCheckoutRequestIds(
      opened.db,
      toDbTime((deps.now ?? (() => new Date()))()),
      deps.limit ?? 10,
    );
  } finally {
    await opened.end();
  }
  const results: StripeCheckoutRecoveryResult[] = [];
  for (const requestId of ids) {
    try {
      results.push(await processRequest(deps, requestId, { force: false, actorId: null }));
    } catch {
      // One request-specific database/client failure must not starve later due IDs.
    }
  }
  return results.filter((result) => result.state !== 'not_claimed');
}

export async function reconcileCheckoutRequestNow(
  deps: StripeCheckoutRecoveryDeps,
  requestId: string,
  actorId: number,
): Promise<StripeCheckoutRecoveryResult> {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('checkout_actor_invalid');
  return processRequest(deps, requestId, { force: true, actorId });
}

export async function attachVerifiedCheckoutSession(
  deps: StripeCheckoutRecoveryDeps,
  requestIdValue: string,
  sessionId: string,
  actorId: number,
): Promise<{ state: 'applied' | 'not_claimed' | 'invalid' }> {
  const requestId = parseCheckoutRequestId(requestIdValue);
  if (!/^cs_test_[A-Za-z0-9_]{1,240}$/.test(sessionId)) return { state: 'invalid' };
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('checkout_actor_invalid');
  const opened = (deps.openDb ?? openDb)(deps.env);
  try {
    if (opened.backend !== 'supabase') return { state: 'not_claimed' };
    const now = (deps.now ?? (() => new Date()))();
    const claimed = await claim(opened.db, requestId, now, true, actorId, true);
    if (!claimed) return { state: 'not_claimed' };
    try {
      const raw = await (deps.retrieveCheckout ?? retrieveCheckoutSession)(deps.env, sessionId, {});
      const session = requireRegistrationCheckoutSession(raw, expectedSession(claimed, sessionId));
      const action = recoveryAction(session);
      if (!action || (action === 'attach_open' && session.url === null)) {
        const restored = await releaseRegistrationCheckoutRecoveryClaim(opened.db, claimed, {
          error: 'manual_attach_unresolved', actorId, updatedAt: toDbTime(addMs(now, 2)),
        });
        return { state: restored ? 'invalid' : 'not_claimed' };
      }
      const result = await applySession(opened.db, claimed, session, now, actorId);
      return {
        state: ['confirmed', 'cancelled', 'attached'].includes(result.state) ? 'applied' : 'not_claimed',
      };
    } catch {
      const restored = await releaseRegistrationCheckoutRecoveryClaim(opened.db, claimed, {
        error: 'manual_attach_invalid', actorId, updatedAt: toDbTime(addMs(now, 2)),
      });
      return { state: restored ? 'invalid' : 'not_claimed' };
    }
  } finally {
    await opened.end();
  }
}

export async function cancelPendingCheckoutRequest(
  deps: StripeCheckoutRecoveryDeps,
  requestIdValue: string,
  actorId: number,
  confirmation: string,
): Promise<{ state: 'applied' | 'not_claimed' | 'confirmation_required' }> {
  const requestId = parseCheckoutRequestId(requestIdValue);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('checkout_actor_invalid');
  const opened = (deps.openDb ?? openDb)(deps.env);
  try {
    if (opened.backend !== 'supabase') return { state: 'not_claimed' };
    const identity = await opened.db
      .prepare(
        `SELECT q.registration_id AS registration_id
         FROM church_private.stripe_checkout_requests q
         JOIN registrations r ON r.id=q.registration_id
         WHERE q.request_id=?1 AND r.status='pending'`,
      )
      .bind(requestId)
      .first<{ registration_id: number }>();
    if (!identity) return { state: 'not_claimed' };
    if (confirmation !== `cancel-registration-${identity.registration_id}`) {
      return { state: 'confirmation_required' };
    }
    const now = (deps.now ?? (() => new Date()))();
    const claimed = await claim(opened.db, requestId, now, true, actorId, true);
    if (!claimed) return { state: 'not_claimed' };
    const applied = await cancelClaimedRegistrationCheckoutRequest(opened.db, {
      requestId,
      registrationId: claimed.registrationId,
      claimedState: claimed.state,
      claimVersion: claimed.claimVersion,
      actorId,
      updatedAt: toDbTime(addMs(now, 2)),
    });
    return { state: applied ? 'applied' : 'not_claimed' };
  } finally {
    await opened.end();
  }
}
