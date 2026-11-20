// The registration view builder: every dynamic value is escaped, the token and session
// renderings differ only in how forms are wired, a paid cancel warns about refunds, and
// the question inputs carry aria-invalid / aria-describedby when a field has an error.
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import { VIEW_LABEL_KEYS, renderQuestionField, renderRegistrationView, renderTicketPicker, type RegistrationView } from '../src/lib/regViewHtml';

const labels = Object.fromEntries(VIEW_LABEL_KEYS.map((k) => [k, (en as Record<string, string>)[k]]));
const EVIL = '<img src=x onerror=alert(1)>';

const view = (over: Partial<RegistrationView> = {}): RegistrationView => ({
  event: { id: 7, title: `Picnic ${EVIL}`, when: 'Sunday, July 5, 2026 18:00', where: `Hall "A" ${EVIL}`, notes: `Bring ${EVIL}`, priceText: 'Free' },
  registration: { confirmationNo: 'R26-0001', status: 'confirmed', name: 'Ada', email: 'ada@example.com', phone: '555', partySize: 2, amountText: null, paid: false },
  qrUrl: '/register/qr/7/R26-0001.png',
  attendees: [{ id: 1, name: `Ada ${EVIL}`, active: true }, { id: 2, name: 'Byron', active: true }, { id: 3, name: 'Gone', active: false }],
  answers: [{ label: `Dish ${EVIL}`, value: `Salad ${EVIL}` }],
  questions: [{ id: 11, label: 'Dish', type: 'text', required: true, options: [], value: [`Salad ${EVIL}`] }],
  canEdit: true,
  canCancel: true,
  ...over,
});

describe('renderRegistrationView', () => {
  it('escapes every dynamic value', () => {
    const html = renderRegistrationView(view(), { mode: 'token', labels, isNew: true });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Hall &quot;A&quot;');
  });

  it('shows the confirmation number, QR, status, people, answers and the edit form', () => {
    const html = renderRegistrationView(view(), { mode: 'token', labels });
    expect(html).toContain('R26-0001');
    expect(html).toContain('src="/register/qr/7/R26-0001.png"');
    expect(html).toContain('data-status="confirmed"');
    expect(html).toContain('name="attendee_1"');
    expect(html).toContain('name="a_11"');
    expect(html).toContain('Cancelled</span>'); // the person who left
    expect(html).not.toContain('Gone</span><button');
  });

  it('wires token mode for the page script and session mode as plain post forms', () => {
    const token = renderRegistrationView(view(), { mode: 'token', labels });
    expect(token).toContain('data-reg-form="cancel_all"');
    expect(token).toContain('data-ask=');
    expect(token).not.toContain('method="post"');
    expect(token).not.toContain('data-confirm=');
    const session = renderRegistrationView(view(), { mode: 'session', action: '/en/my/events/9', labels });
    expect(session).toContain('method="post" action="/en/my/events/9"');
    expect(session).toContain('name="action" value="cancel_all"');
    expect(session).toContain('data-confirm=');
    expect(session).not.toContain('data-reg-form');
  });

  it('offers per-person cancel only with more than one active person and when cancelling is allowed', () => {
    const two = renderRegistrationView(view(), { mode: 'token', labels });
    expect(two.match(/data-reg-form="cancel_attendee"/g)).toHaveLength(2);
    const one = renderRegistrationView(view({ attendees: [{ id: 1, name: 'Ada', active: true }] }), { mode: 'token', labels });
    expect(one).not.toContain('cancel_attendee');
    const locked = renderRegistrationView(view({ canEdit: false, canCancel: false }), { mode: 'token', labels });
    expect(locked).not.toContain('cancel_all');
    expect(locked).not.toContain('data-reg-form="update"');
    expect(locked).toContain(labels['register.manage.locked']);
  });

  it('warns about the refund before a paid registration is cancelled', () => {
    const paid = renderRegistrationView(
      view({ registration: { ...view().registration, paid: true, amountText: '$50.00' } }),
      { mode: 'token', labels },
    );
    expect(paid).toContain('contact the church office about a refund');
    expect(paid).toContain('$50.00');
    expect(renderRegistrationView(view(), { mode: 'token', labels })).not.toContain('about a refund');
  });

  it('banners the first visit by status, and marks edit errors for assistive tech', () => {
    expect(renderRegistrationView(view(), { mode: 'token', labels, isNew: true })).toContain('data-banner="confirmed"');
    const waitlist = renderRegistrationView(view({ registration: { ...view().registration, status: 'waitlist' } }), { mode: 'token', labels, isNew: true });
    expect(waitlist).toContain('on the waitlist');
    const bad = renderRegistrationView(view(), { mode: 'token', labels, errors: [{ path: 'contact.phone', code: 'invalid' }, { path: 'q.11', code: 'missing_required' }] });
    expect(bad).toContain('id="e-summary"');
    expect(bad).toContain('aria-invalid="true" aria-describedby="e-phone-err"');
    expect(bad).toContain('id="e-q-11-err"');
  });

  it('shows what was typed beside the error, so a bounced edit loses nothing', () => {
    const html = renderRegistrationView(view(), {
      mode: 'session',
      action: '/en/my/events/9',
      labels,
      errors: [{ path: 'contact.phone', code: 'invalid' }],
      fields: { name: ['Ada Typed'], phone: ['call me'], attendee_2: ['Byron Typed'], a_11: ['Typed answer'] },
    });
    expect(html).toContain('value="Ada Typed"');
    expect(html).toContain('value="call me"');
    expect(html).toContain('value="Byron Typed"');
    expect(html).toContain('value="Typed answer"');
    expect(html).not.toContain('value="Ada"'); // the stored name is replaced, not shown twice
    expect(html).toContain('aria-describedby="e-phone-err"');
  });

  it('shows no actions on a cancelled registration', () => {
    const html = renderRegistrationView(view({ registration: { ...view().registration, status: 'cancelled' }, canEdit: false, canCancel: false }), { mode: 'token', labels });
    expect(html).not.toContain('data-reg-form');
    expect(html).not.toContain(labels['register.manage.locked']);
  });
});

describe('renderQuestionField', () => {
  const base = { id: 1, label: 'Pick', required: true, options: ['x', 'y'], value: ['y'] as string[] };
  const opts = { name: '1', id: 'f-q-1', yes: 'Yes', no: 'No' };
  it('renders each type with the current value', () => {
    expect(renderQuestionField({ ...base, type: 'select' }, opts)).toContain('<option value="y" selected>');
    expect(renderQuestionField({ ...base, type: 'checkbox', value: ['x', 'y'] }, opts).match(/checked/g)).toHaveLength(2);
    expect(renderQuestionField({ ...base, type: 'yesno', value: ['no'] }, opts)).toMatch(/value="no" required checked/);
    expect(renderQuestionField({ ...base, type: 'textarea', value: ['a<b'] }, opts)).toContain('a&lt;b</textarea>');
  });
  it('ties an error to the first control', () => {
    const html = renderQuestionField({ ...base, type: 'text' }, { ...opts, error: 'Please answer' });
    expect(html).toContain('aria-invalid="true" aria-describedby="f-q-1-err"');
    expect(html).toContain('<p id="f-q-1-err"');
  });
});

// ── Phase 3: field types, help, sections, ticket picker, per-person answers ─

describe('renderQuestionField: the Phase 3 types', () => {
  const base = { id: 5, label: 'Q', required: false, options: [] as string[], value: [] as string[] };
  const opts = { name: '5', id: 'f-q-5', yes: 'Yes', no: 'No', helpLabel: 'More about this question' };

  it('uses the right input for number, date, email and phone, with placeholder and maxlength', () => {
    expect(renderQuestionField({ ...base, type: 'number', value: ['3'] }, opts)).toMatch(/type="number" inputmode="decimal" step="any"[^>]*value="3"/);
    expect(renderQuestionField({ ...base, type: 'date' }, opts)).toContain('type="date"');
    expect(renderQuestionField({ ...base, type: 'email' }, opts)).toMatch(/type="email" inputmode="email"/);
    expect(renderQuestionField({ ...base, type: 'phone' }, opts)).toMatch(/type="tel" inputmode="tel"/);
    const text = renderQuestionField({ ...base, type: 'text', placeholder: 'e.g. 4 <pies>', maxLength: 80 }, opts);
    expect(text).toContain('placeholder="e.g. 4 &lt;pies&gt;"');
    expect(text).toContain('maxlength="80"');
    expect(renderQuestionField({ ...base, type: 'textarea', maxLength: 300 }, opts)).toContain('maxlength="300"');
  });

  it('shows option LABELS (never the key) and submits the key', () => {
    const html = renderQuestionField({ ...base, type: 'select', options: ['o1k', 'o2k'], optionLabels: { o1k: 'Vegetarian' }, value: ['o1k'] }, opts);
    expect(html).toContain('<option value="o1k" selected>Vegetarian</option>');
    expect(html).toContain('<option value="o2k">o2k</option>'); // no label in any language: the key, as the fallback
    const boxes = renderQuestionField({ ...base, type: 'checkbox', options: ['a1'], optionLabels: { a1: 'Nuts' } }, opts);
    expect(boxes).toContain('value="a1"');
    expect(boxes).toContain('<span>Nuts</span>');
  });

  it('puts ⓘ help in a details element (no script) and shows a required star', () => {
    const html = renderQuestionField({ ...base, type: 'text', required: true, help: 'Only <b>this</b> year.' }, opts);
    expect(html).toContain('<details class="reg-help"><summary aria-label="More about this question">');
    expect(html).toContain('Only &lt;b&gt;this&lt;/b&gt; year.');
    expect(html).toContain('class="reg-star"');
  });

  it('shows a terms question as its text above one required checkbox, and a section as a heading with no input', () => {
    const terms = renderQuestionField({ ...base, type: 'terms', label: 'I agree', required: true, help: 'Photos may be shared.' }, opts);
    expect(terms).toContain('<p class="reg-terms">Photos may be shared.</p>');
    expect(terms).toMatch(/<input[^>]*type="checkbox"[^>]*name="5"[^>]*value="on"[^>]*required/);
    expect(terms).not.toContain('<details');
    const section = renderQuestionField({ ...base, type: 'section', label: 'About you', help: 'Tell us more.' }, opts);
    expect(section).toContain('<h3>About you</h3>');
    expect(section).toContain('Tell us more.');
    expect(section).not.toContain('<input');
  });

  it('leaves `required` to the page script for conditional questions and extra people, but still marks the controls', () => {
    const html = renderQuestionField({ ...base, type: 'text', required: true }, { ...opts, nativeRequired: false });
    expect(html).not.toMatch(/ required/);
    expect(html).toContain('data-req');
    const box = renderQuestionField({ ...base, type: 'checkbox', required: true, options: ['a'] }, opts);
    expect(box).not.toContain('data-req'); // a checkbox group has no native required to switch
  });
});

describe('renderTicketPicker', () => {
  const choices = [
    { id: 7, label: 'Adult', description: 'Ages 13+', priceText: '$20.00', leftText: null, disabled: false, note: null },
    { id: 8, label: 'Child', description: null, priceText: 'Free', leftText: '1 left', disabled: false, note: null },
    { id: 9, label: 'Baby', description: null, priceText: 'Free', leftText: null, disabled: true, note: 'Sold out' },
  ];
  it('renders radio cards with label, description, price and what is left; a sold-out type is disabled and stays locked', () => {
    const html = renderTicketPicker({ name: 'ticket_1', id: 'f-ticket-1', legend: 'Ticket type', choices, value: '8', nativeRequired: false });
    expect(html).toContain('name="ticket_1" value="7" data-req');
    expect(html).not.toMatch(/value="7" data-req required/);
    expect(html).toContain('Ages 13+');
    expect(html).toContain('1 left');
    expect(html).toMatch(/value="8"[^>]*checked/);
    expect(html).toMatch(/value="9"[^>]*disabled data-locked/);
    expect(html).toContain('Sold out');
    expect(renderTicketPicker({ name: 'ticket_0', id: 'f-ticket-0', legend: 'T', choices, value: '' })).toContain('data-req required');
  });
});

describe('the registration view with ticket types and per-person answers', () => {
  const personQuestions: RegistrationView['questions'] = [
    { id: 21, label: 'Meal', type: 'select', required: true, options: ['v', 'p'], optionLabels: { v: 'Vegan', p: 'Plain' }, value: [], scope: 'attendee', sort: 1 },
    { id: 22, label: 'Notes', type: 'text', required: false, options: [], value: [], scope: 'attendee', sort: 2, condition: { q: 21, op: 'eq', value: 'v' } },
  ];
  const typedView = (): RegistrationView => view({
    attendees: [
      { id: 1, name: 'Ada', active: true, ticketText: 'Adult · $20.00', answers: [{ label: 'Meal', value: 'Vegan' }], values: { '21': ['v'], '22': ['no nuts'] } },
      { id: 2, name: 'Mia', active: true, ticketText: 'Child', answers: [], values: {} },
    ],
    answers: [],
    questions: [],
    personQuestions,
  });

  it('shows each person with their ticket type and answers, and a read-only ticket line in the edit form', () => {
    const html = renderRegistrationView(typedView(), { mode: 'token', labels });
    expect(html).toContain('data-ticket-text>Adult · $20.00</span>');
    expect(html).toContain('<dt>Meal</dt><dd>Vegan</dd>');
    expect(html).toContain('Ticket type</span> Adult · $20.00');
    expect(html).not.toMatch(/name="ticket/); // the type is never editable
  });

  it('edits per-person answers by attendee id, with a marker, the stored values and the show-if data', () => {
    const html = renderRegistrationView(typedView(), { mode: 'token', labels });
    expect(html).toContain('name="pa_1" value="1"');
    expect(html).toContain('name="pa_2" value="1"');
    expect(html).toMatch(/name="pa_1_21"[\s\S]*?<option value="v" selected>Vegan<\/option>/);
    expect(html).toMatch(/name="pa_1_22"[^>]*value="no nuts"/);
    expect(html).toMatch(/name="pa_2_21"/);
    expect(html).toContain('<script type="application/json" data-reg-conditions>');
    expect(html).toContain('"condition":{"q":21,"op":"eq","value":"v"}');
  });

  it('reads a per-person problem under that person\'s field (by position among active people)', () => {
    const html = renderRegistrationView(typedView(), { mode: 'token', labels, errors: [{ path: 'attendees.1.q.21', code: 'missing_required' }] });
    expect(html).toMatch(/id="e-pq-2-21"[^>]*aria-invalid="true"/);
    expect(html).toContain('Please answer this question.');
  });
});
