// Compatibility-only tombstone for the legacy pending_email/token workflow.
// Public callers must use beginContactChange/completeContactChange instead.
import type { AppDb } from './appDb';

export async function requestEmailChange(
  _db: AppDb,
  _personId: number,
  _newEmail: string,
): Promise<{ error: 'retired' }> {
  return { error: 'retired' };
}

export async function peekEmailChange(_db: AppDb, _rawToken: string): Promise<null> {
  return null;
}

export async function consumeEmailChange(_db: AppDb, _rawToken: string): Promise<{ error: 'invalid' }> {
  return { error: 'invalid' };
}
