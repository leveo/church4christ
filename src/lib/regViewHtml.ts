// One registration, as HTML: the question inputs shared by the register form and the
// edit form, and the whole "your registration" view (details, QR, people, answers,
// edit form, cancel) that the private manage page (token, rendered in the browser)
// and /my/events/<id> (signed in, rendered on the server) both show.
//
// Isomorphic on purpose: no server or Astro imports, so the same builder runs in the
// Worker and in the manage page's script. Every dynamic value goes through esc(), the
// view is plain data, and the copy arrives as a labels map (built with t() by the
// caller, placeholders left in place and filled here with escaped values).
import { badge, btn, btnDanger, btnSecondary, errorText, lab, tin } from './adminUi';

/** esc(): HTML-escape a value for text and double-quoted attribute positions. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type ViewStatus = 'pending' | 'review' | 'confirmed' | 'waitlist' | 'declined' | 'cancelled';

export interface ViewQuestion {
  id: number;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'yesno';
  required: boolean;
  options: string[];
  /** Current answer(s); a checkbox group may have several. */
  value: string[];
}

/** What the manage page, the member page and the API share: display-ready, no token, no hash. */
export interface RegistrationView {
  event: { id: number; title: string; when: string; where: string | null; notes: string | null; priceText: string | null };
  registration: {
    confirmationNo: string | null;
    status: ViewStatus;
    name: string;
    email: string;
    phone: string | null;
    partySize: number;
    amountText: string | null;
    paid: boolean;
  };
  qrUrl: string | null;
  attendees: Array<{ id: number; name: string; active: boolean }>;
  answers: Array<{ label: string; value: string }>;
  /** Present for the edit form (only when canEdit). */
  questions: ViewQuestion[];
  canEdit: boolean;
  canCancel: boolean;
}

export interface ViewError {
  path: string;
  code: string;
}

/** The dictionary key for one validation error (every code the submission and edit validators emit). */
export function submissionErrorKey(error: ViewError): string {
  const { path, code } = error;
  if (code === 'required') return 'register.err.required';
  if (code === 'too_long') return 'register.err.tooLong';
  if (code === 'too_many') return 'register.err.tooMany';
  if (code === 'missing_required') return 'register.err.answerRequired';
  if (code === 'bad_answer') return 'register.err.answerInvalid';
  if (code === 'no_room') return 'register.error.notEnough';
  if (code === 'invalid') {
    if (path === 'contact.email') return 'register.err.email';
    if (path === 'contact.phone') return 'register.err.phone';
    return 'register.err.invalid';
  }
  if (code === 'not_found' || code === 'not_allowed') return 'register.manage.notAllowed';
  return 'register.err.invalid';
}

/** Every dictionary key the view and the manage script read. */
export const VIEW_LABEL_KEYS = [
  'register.manage.title', 'register.manage.confirmation', 'register.manage.when', 'register.manage.where',
  'register.manage.people', 'register.manage.amount', 'register.manage.notes', 'register.manage.qrAlt',
  'register.manage.qrCaption', 'register.manage.peopleHeading', 'register.manage.cantCome',
  'register.manage.cantComeConfirm', 'register.manage.personCancelled', 'register.manage.answersHeading',
  'register.manage.calendar', 'register.manage.editHeading', 'register.manage.editHint', 'register.manage.save',
  'register.manage.emailFixed', 'register.manage.cancelHeading', 'register.manage.cancelAll',
  'register.manage.cancelConfirm', 'register.manage.cancelPaidConfirm', 'register.manage.refundNote',
  'register.manage.locked', 'register.manage.notAllowed', 'register.manage.failed', 'register.manage.invalidLink',
  'register.manage.unavailable', 'register.manage.loading', 'register.manage.saved', 'register.manage.cancelledNotice',
  'register.manage.bannerRegistered', 'register.manage.bannerWaitlist', 'register.manage.bannerPaid',
  'register.manage.statusLabel', 'register.manage.status.confirmed', 'register.manage.status.waitlist',
  'register.manage.status.pending', 'register.manage.status.review', 'register.manage.status.cancelled',
  'register.manage.status.declined', 'register.manage.fixErrors',
  'register.name', 'register.email', 'register.phone', 'register.party.person', 'register.price', 'register.yes', 'register.no',
  'register.err.required', 'register.err.tooLong', 'register.err.tooMany', 'register.err.answerRequired',
  'register.err.answerInvalid', 'register.err.invalid', 'register.err.email', 'register.err.phone',
] as const;

export type ViewLabels = Record<string, string>;

const L = (labels: ViewLabels, key: string, vars: Record<string, string | number> = {}): string =>
  (labels[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));

// ── Question inputs ─────────────────────────────────────────────────────────

/**
 * One question's input(s). `name` is the form field name, `id` the DOM id of the first
 * control; `error` (already translated) marks the field invalid and is tied to it with
 * aria-describedby. Used by the register form (`name` = the question id) and the edit
 * form (`a_<id>`).
 */
export function renderQuestionField(
  q: ViewQuestion,
  opts: { name: string; id: string; error?: string | null; yes: string; no: string },
): string {
  const { name, id, error } = opts;
  const errId = `${id}-err`;
  const aria = error ? ` aria-invalid="true" aria-describedby="${esc(errId)}"` : '';
  const required = q.required ? ' required' : '';
  const first = q.value[0] ?? '';
  let control = '';
  if (q.type === 'text') {
    control = `<input id="${esc(id)}" name="${esc(name)}" aria-label="${esc(q.label)}"${required} class="${tin}" value="${esc(first)}"${aria}>`;
  } else if (q.type === 'textarea') {
    control = `<textarea id="${esc(id)}" name="${esc(name)}" aria-label="${esc(q.label)}"${required} rows="4" class="${tin}"${aria}>${esc(first)}</textarea>`;
  } else if (q.type === 'select') {
    control = `<select id="${esc(id)}" name="${esc(name)}" aria-label="${esc(q.label)}"${required} class="${tin}"${aria}><option value="">—</option>${q.options
      .map((o) => `<option value="${esc(o)}"${o === first ? ' selected' : ''}>${esc(o)}</option>`)
      .join('')}</select>`;
  } else if (q.type === 'checkbox') {
    control = `<div class="space-y-1">${q.options
      .map(
        (o, i) =>
          `<label class="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" ${i === 0 ? `id="${esc(id)}" ` : ''}name="${esc(name)}" value="${esc(o)}"${q.value.includes(o) ? ' checked' : ''}${i === 0 ? aria : ''}><span>${esc(o)}</span></label>`,
      )
      .join('')}</div>`;
  } else {
    const yes = first === 'yes';
    const no = first === 'no';
    control = `<div class="flex gap-4"><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" id="${esc(id)}" name="${esc(name)}" value="yes"${required}${yes ? ' checked' : ''}${aria}><span>${esc(opts.yes)}</span></label><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="${esc(name)}" value="no"${required}${no ? ' checked' : ''}><span>${esc(opts.no)}</span></label></div>`;
  }
  return `<fieldset class="block"><legend class="${lab}">${esc(q.label)}</legend>${control}${error ? `<p id="${esc(errId)}" class="${errorText}">${esc(error)}</p>` : ''}</fieldset>`;
}

// ── The registration view ───────────────────────────────────────────────────

export interface RenderOptions {
  /** 'token': forms carry data-reg-form and the page script posts JSON; 'session': plain POST forms to `action`. */
  mode: 'token' | 'session';
  /** Session mode: where the forms post. */
  action?: string;
  labels: ViewLabels;
  /** Notice after an action: 'saved' | 'cancelled' (translated by the labels). */
  notice?: 'saved' | 'cancelled' | null;
  /** First-visit banner after registering. */
  isNew?: boolean;
  /** Edit-form validation problems from the last attempt. */
  errors?: ViewError[];
  /** What was typed in the last attempt (edit-form field names): shown instead of the stored values, so a bounced edit loses nothing. */
  fields?: Record<string, string[]>;
}

const STATUS_CHIP: Record<ViewStatus, string> = {
  confirmed: 'bg-success-soft text-success',
  waitlist: 'bg-warn-soft text-warn',
  pending: 'bg-warn-soft text-warn',
  review: 'bg-warn-soft text-warn',
  cancelled: 'bg-surface-sunken text-ink-muted',
  declined: 'bg-surface-sunken text-ink-muted',
};

function formOpen(o: RenderOptions, action: string, extra = ''): string {
  return o.mode === 'session'
    ? `<form method="post" action="${esc(o.action ?? '')}"${extra}><input type="hidden" name="action" value="${esc(action)}">`
    : `<form data-reg-form="${esc(action)}"${extra}>`;
}

/** The banner shown on the first visit after registering, by status. */
export function bannerKey(status: ViewStatus, paid: boolean): string {
  if (status === 'waitlist') return 'register.manage.bannerWaitlist';
  return paid ? 'register.manage.bannerPaid' : 'register.manage.bannerRegistered';
}

export function renderRegistrationView(view: RegistrationView, o: RenderOptions): string {
  const { labels: lb } = o;
  const { event, registration: reg } = view;
  const active = view.attendees.filter((a) => a.active);
  const status = reg.status;
  const live = status !== 'cancelled' && status !== 'declined';
  const errorsByPath = new Map<string, string>();
  for (const e of o.errors ?? []) if (!errorsByPath.has(e.path)) errorsByPath.set(e.path, L(lb, submissionErrorKey(e)));
  const out: string[] = [];

  if (o.isNew && live) {
    out.push(`<p class="reg-banner" role="status" data-banner="${esc(status)}">${esc(L(lb, bannerKey(status, reg.paid)))}</p>`);
  }
  if (o.notice === 'saved') out.push(`<p class="reg-banner" role="status">${esc(L(lb, 'register.manage.saved'))}</p>`);
  if (o.notice === 'cancelled') out.push(`<p class="reg-banner" role="status">${esc(L(lb, 'register.manage.cancelledNotice'))}</p>`);

  out.push(
    `<header class="reg-head"><p class="gathering-eyebrow">${esc(L(lb, 'register.manage.title'))}</p><h1 class="font-display text-heading-md font-bold">${esc(event.title)}</h1><p><span class="${badge} ${STATUS_CHIP[status]}" data-status="${esc(status)}" aria-label="${esc(L(lb, 'register.manage.statusLabel'))}">${esc(L(lb, `register.manage.status.${status}`))}</span></p></header>`,
  );

  // Details + QR.
  const rows: Array<[string, string]> = [];
  if (reg.confirmationNo) rows.push([L(lb, 'register.manage.confirmation'), `<span class="reg-number" data-confirmation>${esc(reg.confirmationNo)}</span>`]);
  rows.push([L(lb, 'register.manage.when'), esc(event.when)]);
  if (event.where) rows.push([L(lb, 'register.manage.where'), esc(event.where)]);
  rows.push([L(lb, 'register.manage.people'), esc(active.length || reg.partySize)]);
  if (reg.paid && reg.amountText) rows.push([L(lb, 'register.manage.amount'), esc(reg.amountText)]);
  else if (event.priceText) rows.push([L(lb, 'register.price'), esc(event.priceText)]);
  out.push(
    `<section class="reg-card"><dl class="reg-facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>${
      view.qrUrl && status === 'confirmed'
        ? `<figure class="reg-qr"><img src="${esc(view.qrUrl)}" alt="${esc(L(lb, 'register.manage.qrAlt'))}" width="160" height="160"><figcaption>${esc(L(lb, 'register.manage.qrCaption'))}</figcaption></figure>`
        : ''
    }${event.notes ? `<div class="reg-notes"><h2>${esc(L(lb, 'register.manage.notes'))}</h2><p>${esc(event.notes)}</p></div>` : ''}</section>`,
  );

  // People and answers sit side by side with the details on wide screens.
  const side: string[] = [];
  side.push(
    `<section class="reg-card"><h2>${esc(L(lb, 'register.manage.peopleHeading'))}</h2><ul class="reg-people">${view.attendees
      .map((a) => {
        if (!a.active) {
          return `<li class="reg-person reg-person-gone"><span>${esc(a.name)}</span><span class="text-ink-muted text-xs">${esc(L(lb, 'register.manage.personCancelled'))}</span></li>`;
        }
        const ask = L(lb, 'register.manage.cantComeConfirm', { name: a.name });
        const button = view.canCancel && active.length > 1
          ? (o.mode === 'session'
              ? `<form method="post" action="${esc(o.action ?? '')}" data-confirm="${esc(ask)}"><input type="hidden" name="action" value="cancel_attendee"><input type="hidden" name="attendee_id" value="${a.id}"><button type="submit" class="${btnSecondary}">${esc(L(lb, 'register.manage.cantCome'))}</button></form>`
              : `<form data-reg-form="cancel_attendee" data-ask="${esc(ask)}"><input type="hidden" name="attendee_id" value="${a.id}"><button type="submit" class="${btnSecondary}">${esc(L(lb, 'register.manage.cantCome'))}</button></form>`)
          : '';
        return `<li class="reg-person"><span>${esc(a.name)}</span>${button}</li>`;
      })
      .join('')}</ul></section>`,
  );

  if (view.answers.length > 0) {
    side.push(
      `<section class="reg-card"><h2>${esc(L(lb, 'register.manage.answersHeading'))}</h2><dl class="reg-facts">${view.answers
        .map((a) => `<div><dt>${esc(a.label)}</dt><dd>${esc(a.value)}</dd></div>`)
        .join('')}</dl></section>`,
    );
  }
  out.push(`<div class="reg-side">${side.join('')}</div>`);

  // Edit form.
  if (view.canEdit) {
    const err = (path: string) => errorsByPath.get(path);
    const typed = o.fields;
    const field = (id: string, name: string, label: string, stored: string, path: string, extra = '') => {
      const e = err(path);
      const value = typed && name in typed ? (typed[name][0] ?? '') : stored;
      return `<label class="block"><span class="${lab}">${esc(label)}</span><input id="${esc(id)}" name="${esc(name)}" class="${tin}" value="${esc(value)}"${extra}${e ? ` aria-invalid="true" aria-describedby="${esc(id)}-err"` : ''}>${e ? `<p id="${esc(id)}-err" class="${errorText}">${esc(e)}</p>` : ''}</label>`;
    };
    const people = active
      .map((a, i) => field(`e-attendee-${a.id}`, `attendee_${a.id}`, L(lb, 'register.party.person', { n: i + 1 }), a.name, `attendees.${i}.name`, ' maxlength="120"'))
      .join('');
    const questions = view.questions
      .map((q) => (typed && `a_${q.id}` in typed ? { ...q, value: typed[`a_${q.id}`] } : q))
      .map((q) => renderQuestionField(q, { name: `a_${q.id}`, id: `e-q-${q.id}`, error: err(`q.${q.id}`), yes: L(lb, 'register.yes'), no: L(lb, 'register.no') }))
      .join('');
    out.push(
      `<section class="reg-card" id="reg-edit"><h2>${esc(L(lb, 'register.manage.editHeading'))}</h2><p class="text-sm text-ink-muted">${esc(L(lb, 'register.manage.editHint'))}</p>${formOpen(o, 'update', ' class="mt-4 space-y-4" novalidate')}${
        (o.errors?.length ?? 0) > 0 ? `<p class="reg-error-summary" role="alert" tabindex="-1" id="e-summary">${esc(L(lb, 'register.manage.fixErrors'))}</p>` : ''
      }${field('e-name', 'name', L(lb, 'register.name'), reg.name, 'contact.name', ' maxlength="120" required')}<div><span class="${lab}">${esc(L(lb, 'register.email'))}</span><p class="text-sm">${esc(reg.email)}</p><p class="text-xs text-ink-subtle">${esc(L(lb, 'register.manage.emailFixed'))}</p></div>${field('e-phone', 'phone', L(lb, 'register.phone'), reg.phone ?? '', 'contact.phone', ' type="tel" maxlength="40" inputmode="tel"')}${people}${questions}<button type="submit" class="${btn}">${esc(L(lb, 'register.manage.save'))}</button></form></section>`,
    );
  } else if (live) {
    out.push(`<p class="gathering-registration-note">${esc(L(lb, 'register.manage.locked'))}</p>`);
  }

  // Calendar + cancel.
  const calendar =
    o.mode === 'session'
      ? `<form method="post" action="${esc(o.action ?? '')}"><input type="hidden" name="action" value="ics"><button type="submit" class="${btnSecondary}">${esc(L(lb, 'register.manage.calendar'))}</button></form>`
      : `<form data-reg-form="ics"><button type="submit" class="${btnSecondary}">${esc(L(lb, 'register.manage.calendar'))}</button></form>`;
  const cancelAsk = L(lb, reg.paid ? 'register.manage.cancelPaidConfirm' : 'register.manage.cancelConfirm');
  const cancel = view.canCancel
    ? `<section class="reg-card reg-danger"><h2>${esc(L(lb, 'register.manage.cancelHeading'))}</h2>${reg.paid ? `<p class="text-sm text-ink-muted">${esc(L(lb, 'register.manage.refundNote'))}</p>` : ''}${
        o.mode === 'session'
          ? `<form method="post" action="${esc(o.action ?? '')}" data-confirm="${esc(cancelAsk)}" class="mt-3"><input type="hidden" name="action" value="cancel_all"><button type="submit" class="${btnDanger}">${esc(L(lb, 'register.manage.cancelAll'))}</button></form>`
          : `<form data-reg-form="cancel_all" data-ask="${esc(cancelAsk)}" class="mt-3"><button type="submit" class="${btnDanger}">${esc(L(lb, 'register.manage.cancelAll'))}</button></form>`
      }</section>`
    : '';
  out.push(`<div class="reg-actions">${live ? calendar : ''}</div>${cancel}`);
  return out.join('');
}
