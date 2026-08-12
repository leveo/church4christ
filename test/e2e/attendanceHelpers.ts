import { env, SELF } from 'cloudflare:test';
import { MODULE_KEYS } from '../../src/lib/modules';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { ORIGIN } from './helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

export async function attendanceSessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

export function attendanceModulesBody(disabled: string[]): string {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  return body.toString();
}

export async function consumeStatus(response: Response): Promise<number> {
  const value = response.status;
  await response.arrayBuffer();
  return value;
}

export function attendanceRequest(
  path: string,
  method: string,
  cookie?: string,
  body?: string,
  origin = ORIGIN,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded', origin }),
    },
    body,
    redirect: 'manual',
  });
}
