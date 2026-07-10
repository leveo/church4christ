// The children's check-in kiosk token: a single unguessable value stored in
// the flat settings table (see settings.ts) that gates the public /kiosk/<token>
// pages (T5). No session is required there — the token itself is the gate, so
// regenerating it is how admin revokes a previously shared kiosk link.
import type { AppDb } from './appDb';
import { getSetting, setSetting } from './settings';

export const KIOSK_TOKEN_KEY = 'children.kiosk_token';

/** 32 lowercase hex characters (16 CSPRNG bytes) — unguessable, URL-safe. */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The current kiosk token, or '' if none has been generated yet. */
export async function getKioskToken(db: AppDb): Promise<string> {
  return getSetting(db, KIOSK_TOKEN_KEY);
}

/** The current kiosk token, generating and persisting one on first call. */
export async function ensureKioskToken(db: AppDb): Promise<string> {
  const existing = await getKioskToken(db);
  if (existing) return existing;
  const token = generateToken();
  await setSetting(db, KIOSK_TOKEN_KEY, token);
  return token;
}

/** Replace the kiosk token with a fresh one, invalidating the previous link. */
export async function regenerateKioskToken(db: AppDb): Promise<string> {
  const token = generateToken();
  await setSetting(db, KIOSK_TOKEN_KEY, token);
  return token;
}
