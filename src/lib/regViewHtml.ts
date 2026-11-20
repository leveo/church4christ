// One registration, as HTML: the question inputs shared by the register form and the
// edit form, and the whole "your registration" view (details, QR, people, answers,
// edit form, cancel) that the private manage page (token, rendered in the browser)
// and /my/events/<id> (signed in, rendered on the server) both show.
//
// Isomorphic on purpose: no server or Astro imports, so the same builder runs in the
// Worker and in the manage page's script. Every dynamic value goes through esc(), the
// view is plain data, and the copy arrives as a labels map (built with t() by the
// caller, placeholders left in place and filled here with escaped values).
import type { RegQuestion, RegQuestionType } from './regDb';
import type { Condition, ConditionQuestion } from './regConditions';
import { badge, btn, btnDanger, btnSecondary, errorText, lab, tin } from './adminUi';

/** esc(): HTML-escape a value for text and double-quoted attribute positions. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type ViewStatus = 'pending' | 'review' | 'confirmed' | 'waitlist' | 'declined' | 'cancelled';

export interface ViewQuestion {
  id: number;
  label: string;
  type: RegQuestionType;
  required: boolean;
  /** The option KEYS (select / checkbox); the page shows `optionLabels[key]`, else the key. */
  options: string[];
  /** Current answer(s); a checkbox group may have several. */
  value: string[];
  optionLabels?: Record<string, string>;
  /** The ⓘ help text (the terms text of a `terms` question, the intro of a `section`). */
  help?: string | null;
  placeholder?: string | null;
  maxLength?: number | null;
  scope?: 'registration' | 'attendee';
  condition?: Condition | null;
  /** Position in the form (conditions refer to EARLIER questions, so order matters to the show-if script). */
  sort?: number;
}

/** A question as the form and the edit form show it (a stored answer or the form's typed value goes in `value`). */
export function toViewQuestion(q: RegQuestion, value: string[] = []): ViewQuestion {
  return {
    id: q.id,
    label: q.label,
    type: q.type,
    required: q.required === 1,
    options: q.options ?? [],
    value,
    optionLabels: q.option_labels,
    help: q.help,
    placeholder: q.placeholder,
    maxLength: q.max_length,
    scope: q.scope,
    condition: q.condition,
    sort: q.sort,
  };
}

/** The slice of every question the page script needs to decide what is shown (the shared evaluator's input). */
export function toConditionQuestions(
  questions: ReadonlyArray<{ id: number; type: string; options?: readonly string[] | null; scope?: 'registration' | 'attendee'; condition?: Condition | null }>,
): ConditionQuestion[] {
  return questions.map((q) => ({ id: q.id, type: q.type, scope: q.scope ?? 'registration', options: q.options, condition: q.condition ?? null }));
}

/** JSON for a `<script type="application/json">` block: `<` is escaped so the data can never close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
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
  /** Each person; `ticketText` is their ticket type with its price (read-only for the registrant), `answers` their
   *  per-person answers as display text, `values` the stored values the edit form starts from (only when canEdit). */
  attendees: Array<{
    id: number;
    name: string;
    active: boolean;
    ticketText?: string | null;
    answers?: Array<{ label: string; value: string }>;
    values?: Record<string, string[]>;
  }>;
  answers: Array<{ label: string; value: string }>;
  /** Present for the edit form (only when canEdit): the once-per-registration questions, sections included. */
  questions: ViewQuestion[];
  /** The per-person questions of the edit form (values come from each attendee's `values`). */
  personQuestions?: ViewQuestion[];
  canEdit: boolean;
  canCancel: boolean;
}

export interface ViewError {
  path: string;
  code: string;
}

/** The dictionary key for one validation error (every code the submission and edit validators emit). `types` (question
 *  id -> type) lets an answer problem read as what it is: a missing `terms` is "please accept", a bad number or date is
 *  "check this entry", not "choose one of the options". */
export function submissionErrorKey(error: ViewError, types?: ReadonlyMap<number, string>): string {
  const { path, code } = error;
  if (/\.ticket$/.test(path)) return code === 'required' ? 'register.err.ticketRequired' : 'register.err.ticketInvalid';
  const asked = /(?:^|\.)q\.(\d+)$/.exec(path);
  const type = asked ? types?.get(Number(asked[1])) : undefined;
  if (code === 'required') return 'register.err.required';
  if (code === 'too_long') return 'register.err.tooLong';
  if (code === 'too_many') return 'register.err.tooMany';
  if (code === 'missing_required') return type === 'terms' ? 'register.err.termsRequired' : 'register.err.answerRequired';
  if (code === 'bad_answer') return type === undefined || type === 'select' || type === 'checkbox' || type === 'yesno' ? 'register.err.answerInvalid' : 'register.err.invalid';
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
  'register.err.termsRequired', 'register.err.ticketRequired', 'register.err.ticketInvalid', 'register.help.label',
  'register.ticket.type',
] as const;

export type ViewLabels = Record<string, string>;

const L = (labels: ViewLabels, key: string, vars: Record<string, string | number> = {}): string =>
  (labels[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));

// ── Question inputs ─────────────────────────────────────────────────────────

export interface QuestionFieldOptions {
  name: string;
  id: string;
  error?: string | null;
  yes: string;
  no: string;
  /** The accessible name of the ⓘ help toggle. */
  helpLabel?: string;
  /** false: the controls carry `data-req` but not `required`, so the browser never blocks a submit on a question the
   *  visitor cannot see or an extra person nobody added; the page script switches `required` on while it is shown. */
  nativeRequired?: boolean;
}

const star = (required: boolean): string => (required ? '<span class="reg-star" aria-hidden="true"> *</span>' : '');

/**
 * One question's input(s). `name` is the form field name, `id` the DOM id of the first
 * control; `error` (already translated) marks the field invalid and is tied to it with
 * aria-describedby. Used by the register form (`name` = the question id, or `pq_<row>_<id>`
 * for a per-person question) and the edit form (`a_<id>` / `pa_<attendee>_<id>`). The wrapper
 * carries `data-qid` and `data-scope` for the show-if script. A `section` is a heading with its
 * intro text and no input; the ⓘ help is a `<details>` (no script needed); a `terms` question
 * shows its text (the help) above its checkbox.
 */
export function renderQuestionField(q: ViewQuestion, opts: QuestionFieldOptions): string {
  const { name, id, error } = opts;
  const errId = `${id}-err`;
  const scope = q.scope ?? 'registration';
  const wrapper = `data-qid="${q.id}" data-scope="${scope}"`;
  if (q.type === 'section') {
    return `<div class="reg-section" ${wrapper}><h3>${esc(q.label)}</h3>${q.help ? `<p>${esc(q.help)}</p>` : ''}</div>`;
  }
  const aria = error ? ` aria-invalid="true" aria-describedby="${esc(errId)}"` : '';
  const required = q.required && opts.nativeRequired !== false ? ' required' : '';
  const first = q.value[0] ?? '';
  const labelOf = (key: string): string => q.optionLabels?.[key] ?? key;
  const holder = q.placeholder ? ` placeholder="${esc(q.placeholder)}"` : '';
  const limit = q.maxLength ? ` maxlength="${q.maxLength}"` : '';
  let control = '';
  if (q.type === 'text') {
    control = `<input id="${esc(id)}" name="${esc(name)}" type="text" aria-label="${esc(q.label)}"${required}${holder}${limit} class="${tin}" value="${esc(first)}"${aria}>`;
  } else if (q.type === 'number') {
    control = `<input id="${esc(id)}" name="${esc(name)}" type="number" inputmode="decimal" step="any" aria-label="${esc(q.label)}"${required}${holder} class="${tin}" value="${esc(first)}"${aria}>`;
  } else if (q.type === 'date') {
    control = `<input id="${esc(id)}" name="${esc(name)}" type="date" aria-label="${esc(q.label)}"${required} class="${tin}" value="${esc(first)}"${aria}>`;
  } else if (q.type === 'email') {
    control = `<input id="${esc(id)}" name="${esc(name)}" type="email" inputmode="email" autocomplete="off" aria-label="${esc(q.label)}"${required}${holder} class="${tin}" value="${esc(first)}"${aria}>`;
  } else if (q.type === 'phone') {
    control = `<input id="${esc(id)}" name="${esc(name)}" type="tel" inputmode="tel" aria-label="${esc(q.label)}"${required}${holder} class="${tin}" value="${esc(first)}"${aria}>`;
  } else if (q.type === 'terms') {
    control = `${q.help ? `<p class="reg-terms">${esc(q.help)}</p>` : ''}<label class="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" id="${esc(id)}" name="${esc(name)}" value="on"${first !== '' ? ' checked' : ''}${required}${aria}><span>${esc(q.label)}${star(q.required)}</span></label>`;
  } else if (q.type === 'textarea') {
    control = `<textarea id="${esc(id)}" name="${esc(name)}" aria-label="${esc(q.label)}"${required}${holder}${limit} rows="4" class="${tin}"${aria}>${esc(first)}</textarea>`;
  } else if (q.type === 'select') {
    control = `<select id="${esc(id)}" name="${esc(name)}" aria-label="${esc(q.label)}"${required} class="${tin}"${aria}><option value="">—</option>${q.options
      .map((o) => `<option value="${esc(o)}"${o === first ? ' selected' : ''}>${esc(labelOf(o))}</option>`)
      .join('')}</select>`;
  } else if (q.type === 'checkbox') {
    control = `<div class="space-y-1">${q.options
      .map(
        (o, i) =>
          `<label class="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" ${i === 0 ? `id="${esc(id)}" ` : ''}name="${esc(name)}" value="${esc(o)}"${q.value.includes(o) ? ' checked' : ''}${i === 0 ? aria : ''}><span>${esc(labelOf(o))}</span></label>`,
      )
      .join('')}</div>`;
  } else {
    const yes = first === 'yes';
    const no = first === 'no';
    control = `<div class="flex gap-4"><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" id="${esc(id)}" name="${esc(name)}" value="yes"${required}${yes ? ' checked' : ''}${aria}><span>${esc(opts.yes)}</span></label><label class="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="${esc(name)}" value="no"${required}${no ? ' checked' : ''}><span>${esc(opts.no)}</span></label></div>`;
  }
  // The script switches `required` on and off (a hidden question or a collapsed person is never required) on the
  // controls marked data-req: every required control except a checkbox group, which has no native required.
  if (q.required && q.type !== 'checkbox') control = control.replace(/<(input|select|textarea)\b/g, '<$1 data-req');
  // The terms checkbox carries its own label (and star); every other question has a legend.
  const legend = q.type === 'terms' ? `<legend class="${lab}">${esc(q.label)}</legend>` : `<legend class="${lab}">${esc(q.label)}${star(q.required)}</legend>`;
  const help = q.help && q.type !== 'terms'
    ? `<details class="reg-help"><summary aria-label="${esc(opts.helpLabel ?? 'Help')}"><span aria-hidden="true">ⓘ</span></summary><p>${esc(q.help)}</p></details>`
    : '';
  return `<fieldset class="block" ${wrapper}>${legend}${help}${control}${error ? `<p id="${esc(errId)}" class="${errorText}">${esc(error)}</p>` : ''}</fieldset>`;
}

export interface TicketChoice {
  id: number;
  label: string;
  description: string | null;
  priceText: string;
  /** "N left" for a limited type; null for an unlimited one. */
  leftText: string | null;
  /** Sold out and the party cannot join a waitlist: not selectable. */
  disabled: boolean;
  /** A note under the card (the sold-out explanation or the waitlist promise). */
  note: string | null;
}

/** One person's ticket type picker: radio cards with the label, description, price and what is left. */
export function renderTicketPicker(opts: {
  name: string;
  id: string;
  legend: string;
  choices: TicketChoice[];
  value: string;
  error?: string | null;
  nativeRequired?: boolean;
}): string {
  const errId = `${opts.id}-err`;
  const aria = opts.error ? ` aria-invalid="true" aria-describedby="${esc(errId)}"` : '';
  const cards = opts.choices
    .map((c, i) => {
      const flags = `${opts.nativeRequired === false ? ' data-req' : ' data-req required'}${c.disabled ? ' disabled data-locked' : ''}${opts.value === String(c.id) ? ' checked' : ''}`;
      return `<label class="reg-ticket-card${c.disabled ? ' reg-ticket-off' : ''}"><input type="radio" ${i === 0 ? `id="${esc(opts.id)}" ` : ''}name="${esc(opts.name)}" value="${c.id}"${flags}${i === 0 ? aria : ''}><span class="reg-ticket-body"><span class="reg-ticket-head"><span class="reg-ticket-name">${esc(c.label)}</span><span class="reg-ticket-price">${esc(c.priceText)}</span></span>${c.description ? `<span class="reg-ticket-desc">${esc(c.description)}</span>` : ''}${c.leftText ? `<span class="reg-ticket-left">${esc(c.leftText)}</span>` : ''}${c.note ? `<span class="reg-ticket-note">${esc(c.note)}</span>` : ''}</span></label>`;
    })
    .join('');
  return `<fieldset class="block reg-tickets" data-ticket><legend class="${lab}">${esc(opts.legend)}${star(true)}</legend><div class="reg-ticket-cards">${cards}</div>${opts.error ? `<p id="${esc(errId)}" class="${errorText}">${esc(opts.error)}</p>` : ''}</fieldset>`;
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
        const ticket = a.ticketText ? `<span class="reg-ticket-text" data-ticket-text>${esc(a.ticketText)}</span>` : '';
        const given = a.answers && a.answers.length > 0
          ? `<dl class="reg-facts reg-person-answers">${a.answers.map((x) => `<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd></div>`).join('')}</dl>`
          : '';
        return `<li class="reg-person"><span class="reg-person-who"><span>${esc(a.name)}</span>${ticket}</span>${button}${given}</li>`;
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
    const types = new Map<number, string>([...view.questions, ...(view.personQuestions ?? [])].map((q) => [q.id, q.type]));
    const errorOf = (path: string): string | undefined => {
      const hit = (o.errors ?? []).find((e) => e.path === path);
      return hit ? L(lb, submissionErrorKey(hit, types)) : undefined;
    };
    const fieldOpts = (name: string, id: string, path: string): QuestionFieldOptions => ({
      name, id, error: errorOf(path), yes: L(lb, 'register.yes'), no: L(lb, 'register.no'), helpLabel: L(lb, 'register.help.label'),
    });
    const typedValue = (q: ViewQuestion, name: string): ViewQuestion => (typed && name in typed ? { ...q, value: typed[name] } : q);
    const people = active
      .map((a, i) => {
        const mine = (view.personQuestions ?? []).map((q) => {
          const name = `pa_${a.id}_${q.id}`;
          return renderQuestionField(typedValue({ ...q, value: a.values?.[String(q.id)] ?? [] }, name), fieldOpts(name, `e-pq-${a.id}-${q.id}`, `attendees.${i}.q.${q.id}`));
        });
        const extra = (a.ticketText ? `<p class="text-sm"><span class="${lab}">${esc(L(lb, 'register.ticket.type'))}</span> ${esc(a.ticketText)}</p>` : '')
          + (mine.length > 0 ? `<input type="hidden" name="pa_${a.id}" value="1">${mine.join('')}` : '');
        return `<div class="reg-person-block" data-person-block>${field(`e-attendee-${a.id}`, `attendee_${a.id}`, L(lb, 'register.party.person', { n: i + 1 }), a.name, `attendees.${i}.name`, ' maxlength="120"')}${extra ? `<div class="reg-person-extra space-y-3" data-person-extra>${extra}</div>` : ''}</div>`;
      })
      .join('');
    const questions = view.questions
      .map((q) => renderQuestionField(typedValue(q, `a_${q.id}`), fieldOpts(`a_${q.id}`, `e-q-${q.id}`, `q.${q.id}`)))
      .join('');
    const conditional = [...view.questions, ...(view.personQuestions ?? [])].some((q) => q.condition);
    const conditions = conditional
      ? `<script type="application/json" data-reg-conditions>${jsonForScript(toConditionQuestions([...view.questions, ...(view.personQuestions ?? [])].sort((x, y) => (x.sort ?? x.id) - (y.sort ?? y.id))))}</script>`
      : '';
    out.push(
      `<section class="reg-card" id="reg-edit"><h2>${esc(L(lb, 'register.manage.editHeading'))}</h2><p class="text-sm text-ink-muted">${esc(L(lb, 'register.manage.editHint'))}</p>${formOpen(o, 'update', ' class="mt-4 space-y-4" novalidate')}${
        (o.errors?.length ?? 0) > 0 ? `<p class="reg-error-summary" role="alert" tabindex="-1" id="e-summary">${esc(L(lb, 'register.manage.fixErrors'))}</p>` : ''
      }${field('e-name', 'name', L(lb, 'register.name'), reg.name, 'contact.name', ' maxlength="120" required')}<div><span class="${lab}">${esc(L(lb, 'register.email'))}</span><p class="text-sm">${esc(reg.email)}</p><p class="text-xs text-ink-subtle">${esc(L(lb, 'register.manage.emailFixed'))}</p></div>${field('e-phone', 'phone', L(lb, 'register.phone'), reg.phone ?? '', 'contact.phone', ' type="tel" maxlength="40" inputmode="tel"')}${people}${questions}${conditions}<button type="submit" class="${btn}">${esc(L(lb, 'register.manage.save'))}</button></form></section>`,
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
