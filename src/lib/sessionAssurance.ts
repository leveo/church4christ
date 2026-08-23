export const RECENT_STEP_UP_SECONDS = 10 * 60;

export type SessionAuthMethod = 'email_otp' | 'magic_link' | 'screenshot' | 'legacy';

export type SessionAssurance = {
  schemaVersion: 1 | 2;
  sessionId: string | null;
  authMethod: SessionAuthMethod;
  authTime: number | null;
  stepUpTime: number | null;
};

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validEpochSecond(value: number | null): value is number {
  return Number.isSafeInteger(value) && value !== null && value > 0;
}

/**
 * Whether this request carries a recent, user-proven email authentication.
 * The ten-minute boundary is inclusive. Legacy and development screenshot
 * sessions deliberately never satisfy a sensitive-action step-up gate.
 */
export function hasRecentStepUp(
  assurance: SessionAssurance | null | undefined,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!assurance || assurance.schemaVersion !== 2) return false;
  if (typeof assurance.sessionId !== 'string' || !SESSION_ID_RE.test(assurance.sessionId)) return false;
  if (assurance.authMethod !== 'email_otp' && assurance.authMethod !== 'magic_link') return false;
  if (!validEpochSecond(nowEpochSeconds) || !validEpochSecond(assurance.authTime)) return false;
  if (assurance.authTime > nowEpochSeconds) return false;
  if (assurance.stepUpTime !== null) {
    if (!validEpochSecond(assurance.stepUpTime)) return false;
    if (assurance.stepUpTime < assurance.authTime || assurance.stepUpTime > nowEpochSeconds) return false;
  }
  const verifiedAt = assurance.stepUpTime ?? assurance.authTime;
  return nowEpochSeconds - verifiedAt <= RECENT_STEP_UP_SECONDS;
}
