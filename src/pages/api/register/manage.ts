// The private registration manage API. The page at /{locale}/register/manage reads the
// token from its URL fragment (never sent to a server) and POSTs { token, action } here;
// the token is the only credential, compared by SHA-256 in SQL. JSON in, JSON out, never
// cached, and the token is never echoed, logged or put in a URL. A wrong, garbled or
// replaced token gets one uniform 404 body. Browser POSTs are held to same-origin by the
// middleware like every other mutation; this endpoint adds a per-address rate limit.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { consumePublicIpRateLimit } from '../../../lib/newcomerHttp';
import { parseLocale, type Locale } from '../../../lib/locales';
import { findRegistrationByToken, type RegistrationRef } from '../../../lib/regManage';
import { performManageAction, type ManageAction, type NotifyRelease } from '../../../lib/regManageApi';
import { notifyAfterRelease, type RegNotifyEnv } from '../../../lib/regNotify';
import type { FieldBag } from '../../../lib/regPublic';

export const prerender = false;

/** Requests per address per 10 minutes (a page load plus a handful of actions per visit). */
export const MANAGE_RATE_LIMIT = 60;
const MAX_BODY_BYTES = 64 * 1024;

interface ManageDeps {
  secret: string | undefined;
  notifyEnv: RegNotifyEnv;
  findByToken: typeof findRegistrationByToken;
  perform: typeof performManageAction;
  notify: typeof notifyAfterRelease;
  limit: number;
}

const defaultDeps = (): ManageDeps => ({
  secret: (env as unknown as { NEWCOMER_RATE_LIMIT_SECRET?: string }).NEWCOMER_RATE_LIMIT_SECRET,
  notifyEnv: env as unknown as RegNotifyEnv,
  findByToken: findRegistrationByToken,
  perform: performManageAction,
  notify: notifyAfterRelease,
  limit: MANAGE_RATE_LIMIT,
});

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: HEADERS });

function fieldBag(value: unknown): FieldBag {
  const bag: FieldBag = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bag;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 64) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    bag[key] = list.filter((v): v is string => typeof v === 'string').slice(0, 50);
  }
  return bag;
}

export function createManageHandler(makeDeps: () => ManageDeps = defaultDeps): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('registration')) return json({ error: 'not_found' }, 404);
    const deps = makeDeps();

    const limited = await consumePublicIpRateLimit(locals.db, {
      backend: locals.dbBackend,
      secret: deps.secret,
      scope: 'regmanage',
      cfConnectingIp: request.headers.get('cf-connecting-ip'),
      limit: deps.limit,
    });
    if (!limited.ok) return limited.reason === 'limited' ? json({ error: 'rate_limited' }, 429) : json({ error: 'unavailable' }, 503);

    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: 'bad_request' }, 400);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'bad_request' }, 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: 'bad_request' }, 400);
    }

    const ref: RegistrationRef | null = await deps.findByToken(locals.db, body.token);
    if (!ref) return json({ error: 'not_found' }, 404);

    const locale: Locale = parseLocale(String(body.locale ?? '')) ?? parseLocale(ref.locale ?? '') ?? locals.locale;
    const name = String(body.action ?? 'view');
    let action: ManageAction;
    if (name === 'view') action = { action: 'view' };
    else if (name === 'update') action = { action: 'update', fields: fieldBag(body.fields) };
    else if (name === 'cancel_all') action = { action: 'cancel_all' };
    else if (name === 'cancel_attendee') {
      const id = Number(body.attendee_id);
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'bad_request' }, 400);
      action = { action: 'cancel_attendee', attendeeId: id };
    } else if (name === 'ics') action = { action: 'ics', host: new URL(request.url).host };
    else return json({ error: 'bad_request' }, 400);

    const notify: NotifyRelease = (input) => deps.notify(deps.notifyEnv, locals.db, input);
    const outcome = await deps.perform(locals.db, ref, locale, action, notify);
    switch (outcome.kind) {
      case 'view':
        return json({ ok: true, view: outcome.view, notice: outcome.notice });
      case 'ics':
        return new Response(outcome.content, {
          status: 200,
          headers: {
            'content-type': 'text/calendar; charset=utf-8',
            'content-disposition': `attachment; filename="${outcome.filename}"`,
            'cache-control': 'no-store',
          },
        });
      case 'invalid':
        return json({ error: 'invalid', errors: outcome.errors, view: outcome.view }, 422);
      case 'not_allowed':
        return json({ error: 'not_allowed', view: outcome.view }, 409);
      default:
        return json({ error: 'not_found' }, 404);
    }
  };
}

export const POST: APIRoute = createManageHandler();
