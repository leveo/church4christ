// The registration email builders: per status, per language, escaping, and which parts
// (manage link, QR, calendar) each variant carries.
import { describe, expect, it } from 'vitest';
import { cancelledEmail, confirmationEmail, promotedEmail, registrationManageUrl, registrationQrUrl } from '../src/lib/regEmails';
import { loadDict } from '../src/lib/i18n';
import { SUPPORTED_LOCALES, type Locale } from '../src/lib/locales';
import type { RegistrationSummary } from '../src/lib/regManage';

function summary(over: { status?: 'confirmed' | 'waitlist' | 'cancelled'; amount?: number; notes?: string | null } = {}): RegistrationSummary {
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
      { id: 1, name: 'Ada <script>', status: 'active', person_id: null },
      { id: 2, name: 'Bob & Co', status: 'active', person_id: null },
      { id: 3, name: 'Gone Person', status: 'cancelled', person_id: null },
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
