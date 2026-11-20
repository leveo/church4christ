// The private registration manage page's script. The link's token lives in the URL
// fragment (`#t=...`), which browsers never send to a server; this script reads it,
// POSTs it as JSON to /api/register/manage, and renders the returned view with the same
// builder the member's page uses. The token is never written to the page, storage, a
// query string or the console. Bundled with the page (no inline script).
import { initShowIf } from './reg-showif-client';
import { renderRegistrationView, type RegistrationView, type ViewError, type ViewLabels } from './regViewHtml';

const TOKEN_RE = /^#t=([A-Za-z0-9_-]{43})$/u;

/** The token in a location hash, or null. */
export function tokenFromHash(hash: string): string | null {
  return TOKEN_RE.exec(hash)?.[1] ?? null;
}

interface ApiOk { ok: true; view: RegistrationView; notice: 'saved' | 'cancelled' | null }
interface ApiFail { error: string; view?: RegistrationView | null; errors?: ViewError[] }

export function initManagePage(root: Document = document, fetcher: typeof fetch = (...args) => fetch(...args)): void {
  const container = root.getElementById('reg-manage');
  const labelsEl = root.getElementById('reg-manage-labels');
  if (!container || !labelsEl) return;
  const labels = JSON.parse(labelsEl.textContent ?? '{}') as ViewLabels;
  const locale = container.dataset.locale ?? '';
  const isNew = container.dataset.new === '1';
  const token = tokenFromHash(root.location?.hash ?? window.location.hash);

  const message = (key: string): void => {
    const p = root.createElement('p');
    p.className = 'gathering-registration-note';
    p.setAttribute('role', 'alert');
    p.textContent = labels[key] ?? key;
    container.replaceChildren(p);
  };
  if (!token) {
    message('register.manage.invalidLink');
    return;
  }

  // The page's own campus selector rides along, so the API resolves the registration's campus.
  const campus = new URLSearchParams(root.location?.search ?? window.location.search).get('campus');
  const apiUrl = campus ? `/api/register/manage?campus=${encodeURIComponent(campus)}` : '/api/register/manage';
  let busy = false;
  let first = true;
  // The last edit attempt, shown again if the server bounces it.
  let lastFields: Record<string, string[]> | undefined;
  const show = (view: RegistrationView, extra: { notice?: 'saved' | 'cancelled' | null; errors?: ViewError[]; fields?: Record<string, string[]> } = {}): void => {
    container.innerHTML = renderRegistrationView(view, {
      mode: 'token',
      labels,
      isNew: first && isNew,
      notice: extra.notice ?? null,
      errors: extra.errors,
      fields: extra.fields,
    });
    first = false;
    const editForm = container.querySelector<HTMLElement>('#reg-edit form');
    if (editForm) initShowIf(editForm);
    const focus = container.querySelector<HTMLElement>('[aria-invalid="true"]') ?? container.querySelector<HTMLElement>('#e-summary');
    if (focus) focus.focus();
    else if (extra.notice) container.querySelector<HTMLElement>('.reg-banner')?.scrollIntoView({ block: 'nearest' });
  };

  const post = async (action: string, extra: Record<string, unknown> = {}): Promise<Response | null> => {
    try {
      return await fetcher(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({ token, locale, action, ...extra }),
      });
    } catch {
      return null;
    }
  };

  const handle = async (res: Response | null, keepOnFail: boolean): Promise<void> => {
    if (!res) return message('register.manage.failed');
    if (res.status === 404) return message('register.manage.invalidLink');
    if (res.status === 429 || res.status === 503) return message('register.manage.unavailable');
    let body: ApiOk | ApiFail;
    try {
      body = (await res.json()) as ApiOk | ApiFail;
    } catch {
      return message('register.manage.failed');
    }
    if (res.ok && 'view' in body && 'ok' in body) return show(body.view, { notice: body.notice });
    const fail = body as ApiFail;
    if (res.status === 422 && fail.view) return show(fail.view, { errors: fail.errors, fields: lastFields });
    if (res.status === 409 && fail.view) {
      show(fail.view);
      const note = root.createElement('p');
      note.className = 'gathering-registration-note';
      note.setAttribute('role', 'alert');
      note.textContent = labels['register.manage.notAllowed'] ?? '';
      container.insertBefore(note, container.firstChild);
      return;
    }
    if (!keepOnFail) message('register.manage.failed');
  };

  const run = async (action: string, extra: Record<string, unknown> = {}): Promise<void> => {
    if (busy) return;
    busy = true;
    container.setAttribute('aria-busy', 'true');
    try {
      const res = await post(action, extra);
      if (action === 'ics' && res?.ok) {
        const url = URL.createObjectURL(await res.blob());
        const link = root.createElement('a');
        link.href = url;
        link.download = 'event.ics';
        root.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        return;
      }
      await handle(res, action === 'ics');
    } finally {
      busy = false;
      container.removeAttribute('aria-busy');
    }
  };

  container.addEventListener('submit', (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>('[data-reg-form]');
    if (!form) return;
    event.preventDefault();
    const action = form.dataset.regForm ?? '';
    const ask = form.dataset.ask;
    if (ask && !window.confirm(ask)) return;
    const data = new FormData(form);
    if (action === 'update') {
      const fields: Record<string, string[]> = {};
      for (const [key, value] of data.entries()) if (typeof value === 'string') (fields[key] ??= []).push(value);
      lastFields = fields;
      void run('update', { fields });
    } else if (action === 'cancel_attendee') {
      void run('cancel_attendee', { attendee_id: Number(data.get('attendee_id')) });
    } else if (action === 'cancel_all' || action === 'ics') {
      void run(action);
    }
  });

  container.setAttribute('aria-live', 'polite');
  void run('view');
}
