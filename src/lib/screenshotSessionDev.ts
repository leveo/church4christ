import { verifySession } from './session';

interface ScreenshotSessionUser {
  readonly email: string;
}

/**
 * Development-only screenshot attachment. Middleware imports this module only
 * inside a compile-time import.meta.env.DEV branch, and the production build
 * rejects any emitted reference to the module.
 */
export async function loadScreenshotSessionUser<T extends ScreenshotSessionUser>(input: {
  readonly jwt: string;
  readonly secret?: string;
  readonly loadUser: (personId: number, epoch: number) => Promise<T | null>;
}): Promise<T | null> {
  if (
    typeof input.secret !== 'string'
    || input.secret.length < 32
    || /\s/u.test(input.secret)
  ) return null;

  const claims = await verifySession(input.secret, input.jwt);
  if (!claims) return null;
  const user = await input.loadUser(claims.personId, claims.epoch);
  return user?.email === claims.email ? user : null;
}
