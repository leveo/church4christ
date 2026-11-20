// The registration email builders: per status, per language, escaping, and which parts
// (manage link, QR, calendar) each variant carries.
import { describe, expect, it } from 'vitest';
import { bulkEmail, cancelledEmail, confirmationEmail, decisionEmail, promotedEmail, registrationManageUrl, registrationQrUrl, reminderEmail } from '../src/lib/regEmails';
import { bannerKey, statusLabelKey } from '../src/lib/regViewHtml';
import { loadDict } from '../src/lib/i18n';
import { SUPPORTED_LOCALES, type Locale } from '../src/lib/locales';
import type { RegistrationSummary } from '../src/lib/regManage';

function summary(over: { status?: 'confirmed' | 'waitlist' | 'cancelled' | 'review' | 'declined'; amount?: number; notes?: string | null } = {}): RegistrationSummary {
  return {
    event: {
      id: 12, title: 'Fall <Retreat> & Picnic', starts_at: '2031-05-01 23:00:00', ends_at: '2031-05-02 01:00:00',
      location: 'Hall "A"', notes: over.notes === undefined ? 'Bring a dish\nParking <behind>' : over.notes, phase: 'open',
      price_cents: null, currency: 'usd', max_party_size: 4, allow_self_edit: 1,
    },
    registration: {
      id: 7, confirmation_no: 'R31-0042', status: over.status ?? 'confirmed', name: 'Ada <script>', email: 'ada@example.com', phone: null,
      locale: 'en', party_size: 2, amount_cents: over.amount ?? 0, currency: 'usd', created_at: '2031-01-01 00:00:00', cancelled_at: null,
    },
    attendees: [
      { id: 1, name: 'Ada <script>', status: 'active', person_id: null, ticket_type_id: null, ticket_label: null, ticket_price_cents: null, answers: [] },
      { id: 2, name: 'Bob & Co', status: 'active', person_id: null, ticket_type_id: null, ticket_label: null, ticket_price_cents: null, answers: [] },
      { id: 3, name: 'Gone Person', status: 'cancelled', person_id: null, ticket_type_id: null, ticket_label: null, ticket_price_cents: null, answers: [] },
    ],
    answers: [],
    canEdit: true,
    canCancel: true,
  };
}
const links = (locale: Locale) => ({
  locale,
  origin: 'https://church.example',
  manageUrl: registrationManageUrl('https://church.example', locale, 'T'.repeat(43)),
  qrUrl: registrationQrUrl('https://church.example', 12, 'R31-0042'),
});

describe('confirmationEmail', () => {
  it('confirmed: details, escaped once, manage button, QR image and calendar', async () => {
    await loadDict('en');
    const mail = confirmationEmail(summary(), links('en'));
    expect(mail.subject).toBe('You’re registered: Fall <Retreat> & Picnic');
    expect(mail.html).toContain('Fall &lt;Retreat&gt; &amp; Picnic');
    expect(mail.html).toContain('Ada &lt;script&gt;, Bob &amp; Co');
    expect(mail.html).toContain('Hall &quot;A&quot;');
    expect(mail.html).toContain('Bring a dish<br>Parking &lt;behind&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('Gone Person');
    expect(mail.html).toContain('R31-0042');
    expect(mail.html).toContain('Thursday, May 1, 2031 18:00–20:00'); // church time zone, same-day end
    expect(mail.html).toContain('href="https://church.example/en/register/manage#t=' + 'T'.repeat(43) + '"');
    expect(mail.html).toContain('<img src="https://church.example/register/qr/12/R31-0042.png"');
    expect(mail.text).toContain('Fall <Retreat> & Picnic');
    expect(mail.text).toContain('People: Ada <script>, Bob & Co');
    expect(mail.text).not.toContain('&amp;');
    expect(mail.text).toContain('Manage my registration: https://church.example/en/register/manage#t=');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].contentType).toContain('text/calendar');
    expect(String(mail.attachments[0].content)).toContain('UID:registration-7@church.example');
    expect(String(mail.attachments[0].content)).toContain('LOCATION:Hall "A"');
  });

  it('waitlist: waitlist wording, calendar but no QR', async () => {
    await loadDict('en');
    const mail = confirmationEmail(summary({ status: 'waitlist' }), links('en'));
    expect(mail.subject).toContain('on the waitlist');
    expect(mail.html).toContain('On the waitlist');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('/register/manage#t=');
    expect(mail.attachments).toHaveLength(1);
  });

  it('paid: payment wording and the amount', async () => {
    await loadDict('en');
    const mail = confirmationEmail(summary({ amount: 2500 }), links('en'));
    expect(mail.subject).toContain('Payment received');
    expect(mail.text).toContain('Amount paid: $25.00');
    expect(mail.html).toContain('<img');
  });

  it('omits the manage section without a URL, and the QR without a usable confirmation number', async () => {
    await loadDict('en');
    const noLinks = confirmationEmail(summary(), { locale: 'en', origin: 'https://church.example' });
    expect(noLinks.html).not.toContain('register/manage');
    expect(noLinks.html).not.toContain('<img');
    expect(registrationQrUrl('https://x', 1, null)).toBeNull();
    expect(registrationQrUrl('https://x', 1, 'bad number')).toBeNull();
  });

  it('writes Chinese, German and Japanese copy', async () => {
    for (const [locale, subject] of [['zh', '报名成功：Fall <Retreat> & Picnic'], ['de', 'Ihre Anmeldung ist bestätigt: Fall <Retreat> & Picnic'], ['ja', 'お申込みが確定しました：Fall <Retreat> & Picnic']] as const) {
      await loadDict(locale);
      const mail = confirmationEmail(summary(), links(locale));
      expect(mail.subject).toBe(subject);
      expect(mail.html).toContain(`/${locale}/register/manage#t=`);
    }
    await loadDict('zh');
    expect(confirmationEmail(summary(), links('zh')).html).toContain('2031年5月1日 星期四 18:00–20:00');
  });

  it('renders every language with no raw keys or unfilled placeholders', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      await loadDict(locale);
      for (const mail of [
        confirmationEmail(summary(), links(locale)),
        confirmationEmail(summary({ status: 'waitlist' }), links(locale)),
        confirmationEmail(summary({ amount: 500 }), links(locale)),
        promotedEmail(summary(), links(locale)),
        cancelledEmail(summary({ status: 'cancelled' }), { locale }),
        cancelledEmail(summary(), { locale, attendeeName: 'Bob & Co' }),
      ]) {
        const all = `${mail.subject}\n${mail.text}`;
        expect(all, locale).not.toContain('reg.email.');
        expect(all, locale).not.toMatch(/\{\w+\}/);
      }
    }
  });
});

describe('promotedEmail and cancelledEmail', () => {
  it('promotion says a place opened up and carries the link, QR and calendar', async () => {
    await loadDict('en');
    const mail = promotedEmail(summary(), links('en'));
    expect(mail.subject).toBe('A place opened up for you: Fall <Retreat> & Picnic');
    expect(mail.html).toContain('/register/manage#t=');
    expect(mail.html).toContain('<img');
    expect(mail.attachments).toHaveLength(1);
  });

  it('cancellation never carries a manage link, QR or calendar', async () => {
    await loadDict('en');
    const whole = cancelledEmail(summary({ status: 'cancelled' }), { locale: 'en', origin: 'https://church.example', ...({ manageUrl: 'https://x/#t=secret' } as object) });
    expect(whole.subject).toBe('Registration cancelled: Fall <Retreat> & Picnic');
    expect(whole.html + whole.text).not.toContain('secret');
    expect(whole.html).not.toContain('<img');
    expect(whole.attachments).toHaveLength(0);
    expect(whole.html).toContain('Cancelled');
    expect(whole.html).not.toContain('Hall');

    const person = cancelledEmail(summary(), { locale: 'en', attendeeName: 'Bob & Co' });
    expect(person.subject).toBe('Registration updated: Fall <Retreat> & Picnic');
    expect(person.html).toContain('Bob &amp; Co has been removed');
    expect(person.text).toContain('Bob & Co has been removed');
    expect(person.html).not.toContain('register/manage');
    expect(person.attachments).toHaveLength(0);
  });
});

describe('attendee lines with ticket types', () => {
  it('lists a person with their ticket type, and the price when it costs something (per-person answers stay out)', async () => {
    await loadDict('en');
    const s = summary({ amount: 3000 });
    s.attendees[0] = { ...s.attendees[0], ticket_type_id: 7, ticket_label: 'Adult', ticket_price_cents: 2000, answers: [{ question_id: 1, label: 'Meal', value: 'Vegan' }] };
    s.attendees[1] = { ...s.attendees[1], ticket_type_id: 8, ticket_label: 'Child <3>', ticket_price_cents: 0, answers: [] };
    const mail = confirmationEmail(s, links('en'));
    expect(mail.text).toContain('People: Ada <script> (Adult · $20.00), Bob & Co (Child <3>)');
    expect(mail.html).toContain('Ada &lt;script&gt; (Adult · $20.00), Bob &amp; Co (Child &lt;3&gt;)');
    expect(mail.text).not.toContain('Vegan');
    expect(mail.html).not.toContain('Vegan');
  });
});

describe('approval, decision, reminder and bulk emails', () => {
  it('review: "waiting for approval" in every language, never confirmed, no QR or calendar', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      await loadDict(locale);
      const mail = confirmationEmail(summary({ status: 'review' }), links(locale));
      const en = confirmationEmail(summary({ status: 'review' }), links('en'));
      expect(mail.html).not.toContain('<img');
      expect(mail.html + mail.text).not.toContain('/register/qr/');
      expect(mail.attachments).toHaveLength(0);
      expect(mail.subject).toContain('Fall <Retreat> & Picnic');
      if (locale !== 'en') expect(mail.text).not.toBe(en.text); // translated, not English
      expect(mail.text).toContain('#t=');
    }
    await loadDict('en');
    const mail = confirmationEmail(summary({ status: 'review' }), links('en'));
    expect(mail.subject).toBe('We received your registration: Fall <Retreat> & Picnic');
    expect(mail.text).toContain('Status: Waiting for approval');
    expect(mail.text + mail.html).not.toMatch(/Confirmed|You’re registered/);
    // even a promoted-into-review registration (and a stray paid amount) is never labelled confirmed
    const promoted = promotedEmail(summary({ status: 'review' }), links('en'));
    expect(promoted.subject).toBe('A place opened up, waiting for approval: Fall <Retreat> & Picnic');
    expect(promoted.html + promoted.text).not.toMatch(/Confirmed|<img|qr\//);
    expect(promotedEmail(summary(), links('en')).subject).toBe('A place opened up for you: Fall <Retreat> & Picnic');
  });

  it('decisions: accepted carries QR and calendar, waitlisted a link and calendar, declined nothing but a courteous no', async () => {
    await loadDict('en');
    const accepted = decisionEmail(summary(), 'accept', links('en'));
    expect(accepted.subject).toBe('Your registration is approved: Fall <Retreat> & Picnic');
    expect(accepted.html).toContain('<img');
    expect(accepted.html).toContain('Confirmed');
    expect(accepted.attachments).toHaveLength(1);
    const waitlisted = decisionEmail(summary({ status: 'waitlist' }), 'waitlist', links('en'));
    expect(waitlisted.subject).toBe('Update on your registration: Fall <Retreat> & Picnic');
    expect(waitlisted.html).not.toContain('<img');
    expect(waitlisted.html).toContain('#t=');
    expect(waitlisted.attachments).toHaveLength(1);
    const declined = decisionEmail(summary({ status: 'declined' }), 'decline', links('en'));
    expect(declined.subject).toBe('About your registration: Fall <Retreat> & Picnic');
    expect(declined.html + declined.text).not.toMatch(/#t=|<img|register\/manage|Hall|Parking/);
    expect(declined.text).toContain('Not accepted');
    expect(declined.attachments).toHaveLength(0);
    // an accepted mail for a registration that is NOT confirmed never shows a QR
    expect(decisionEmail(summary({ status: 'review' }), 'accept', links('en')).html).not.toContain('<img');
  });

  it('reminder: details, people, notes, QR and link, escaped once', async () => {
    await loadDict('en');
    const mail = reminderEmail(summary(), links('en'));
    expect(mail.subject).toBe('Reminder: Fall <Retreat> & Picnic');
    expect(mail.html).toContain('Ada &lt;script&gt;, Bob &amp; Co');
    expect(mail.html).toContain('Bring a dish<br>Parking &lt;behind&gt;');
    expect(mail.html).toContain('<img');
    expect(mail.html).toContain('#t=');
    expect(mail.attachments).toHaveLength(1);
  });

  it('bulk: plain text in, escaped once, placeholders filled in a single pass, no links', async () => {
    await loadDict('en');
    const mail = bulkEmail(
      { subject: 'Hi {name}\nBcc: x', body: '<b>Dear</b> {name}, {event} {confirmation} {name}\n{event}', name: '{event} & <i>Ada</i>', eventTitle: 'Retreat <1>', confirmationNo: null },
      { locale: 'en' },
    );
    expect(mail.subject).toBe('Hi {event} & <i>Ada</i> Bcc: x'); // one line, raw; a value holding a placeholder is not expanded again
    expect(mail.html).toContain('&lt;b&gt;Dear&lt;/b&gt; {event} &amp; &lt;i&gt;Ada&lt;/i&gt;, Retreat &lt;1&gt;  {event} &amp; &lt;i&gt;Ada&lt;/i&gt;<br>Retreat &lt;1&gt;');
    expect(mail.html).not.toMatch(/<b>|<i>|href|<img/);
    expect(mail.html).toContain('because you registered for Retreat &lt;1&gt;.');
    expect(mail.text).toContain('You’re receiving this message because you registered for Retreat <1>.');
    expect(mail.attachments).toEqual([]);
  });
});

describe('review status labels', () => {
  it('the manage page banner and status label for a registration waiting for approval', () => {
    expect(bannerKey('review', false)).toBe('register.manage.bannerReview');
    expect(bannerKey('waitlist', false)).toBe('register.manage.bannerWaitlist');
    expect(bannerKey('confirmed', true)).toBe('register.manage.bannerPaid');
    expect(statusLabelKey('review')).toBe('register.manage.status.review');
  });
});
