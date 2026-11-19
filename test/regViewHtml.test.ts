// The registration view builder: every dynamic value is escaped, the token and session
// renderings differ only in how forms are wired, a paid cancel warns about refunds, and
// the question inputs carry aria-invalid / aria-describedby when a field has an error.
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import { VIEW_LABEL_KEYS, renderQuestionField, renderRegistrationView, type RegistrationView } from '../src/lib/regViewHtml';

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
