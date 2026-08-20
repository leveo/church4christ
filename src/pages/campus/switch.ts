import type { APIRoute } from 'astro';
import { CAMPUS_COOKIE, resolveCampusContext } from '../../lib/campusDb';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function safeNext(value: FormDataEntryValue | null, requestUrl: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const request = new URL(requestUrl);
    const target = new URL(value, request);
    if (target.origin !== request.origin) return '/';
    return target.pathname + target.search + target.hash;
  } catch {
    return '/';
  }
}

export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const requested = form.get('campus');
  if (typeof requested !== 'string' || !requested.trim()) {
    return new Response('Bad Request', { status: 400 });
  }

  const actor = locals.user;
  const context = await resolveCampusContext(
    locals.rawDb,
    requested,
    actor ? { personId: actor.id, isMasterAdmin: actor.isSuperAdmin } : null,
  );
  if (!context) return new Response(actor ? 'Forbidden' : 'Not Found', { status: actor ? 403 : 404 });

  const value = context.mode === 'all' ? 'all' : context.campus!.slug;
  cookies.set(CAMPUS_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    secure: new URL(request.url).protocol === 'https:',
  });
  return redirect(safeNext(form.get('next'), request.url), 303);
};
