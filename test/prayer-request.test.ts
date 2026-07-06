// Workers project (live D1). Ported from the reference stack's prayer-request API test,
// aimed at the pure lib (src/lib/prayerRequest) the thin route delegates to:
// valid submit stores + returns 'sent', bad/missing fields (incl. the consent
// checkbox) return 'error' without storing, honeypot is silently accepted, and
// the Referer sanitizer keeps redirects same-origin.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { safeReturnPath, submitPrayerRequest } from '../src/lib/prayerRequest';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function count(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM prayer_requests').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM prayer_requests').run();
});

describe('submitPrayerRequest', () => {
  it('stores a valid submission and returns sent', async () => {
    const before = await count();
    const outcome = await submitPrayerRequest(
      env.DB,
      form({ name: '王弟兄', email: 'wang@example.com', message: '请为我的家人祷告。', consent: 'on' }),
    );
    expect(outcome).toBe('sent');
    expect(await count()).toBe(before + 1);
    const row = await env.DB.prepare('SELECT name, email, message FROM prayer_requests ORDER BY id DESC LIMIT 1').first<{
      name: string;
      email: string;
      message: string;
    }>();
    expect(row).toMatchObject({ name: '王弟兄', email: 'wang@example.com', message: '请为我的家人祷告。' });
  });

  it('accepts a message-only submission (name + email optional)', async () => {
    const before = await count();
    expect(await submitPrayerRequest(env.DB, form({ message: 'Just a prayer, no contact info.', consent: 'on' }))).toBe('sent');
    expect(await count()).toBe(before + 1);
    const row = await env.DB.prepare('SELECT name, email FROM prayer_requests ORDER BY id DESC LIMIT 1').first<{ name: string; email: string }>();
    expect(row).toMatchObject({ name: '', email: '' });
  });

  it('rejects a submission without consent without storing (server-side enforcement)', async () => {
    const before = await count();
    expect(await submitPrayerRequest(env.DB, form({ name: 'x', email: 'a@b.c', message: 'please pray' }))).toBe('error');
    expect(await submitPrayerRequest(env.DB, form({ message: 'please pray', consent: 'yes' }))).toBe('error'); // only 'on' counts
    expect(await count()).toBe(before);
  });

  it('rejects an empty message and a malformed email without storing', async () => {
    const before = await count();
    expect(await submitPrayerRequest(env.DB, form({ name: 'x', email: 'a@b.c', message: '', consent: 'on' }))).toBe('error');
    expect(await submitPrayerRequest(env.DB, form({ name: 'x', email: 'not-an-email', message: 'hi', consent: 'on' }))).toBe('error');
    expect(await count()).toBe(before);
  });

  it('caps the stored message at 4000 characters', async () => {
    await submitPrayerRequest(env.DB, form({ message: 'a'.repeat(5000), consent: 'on' }));
    const row = await env.DB.prepare('SELECT message FROM prayer_requests ORDER BY id DESC LIMIT 1').first<{ message: string }>();
    expect(row?.message.length).toBe(4000);
  });

  it('silently drops honeypot submissions (before the consent check)', async () => {
    const before = await count();
    expect(await submitPrayerRequest(env.DB, form({ message: 'spam', website: 'http://spam' }))).toBe('sent');
    expect(await count()).toBe(before);
  });
});

describe('safeReturnPath', () => {
  const origin = 'https://church.example.com';
  it('keeps a same-origin Referer path (dropping query/hash)', () => {
    expect(safeReturnPath('https://church.example.com/zh/?x=1#prayer', origin)).toBe('/zh/');
    expect(safeReturnPath('https://church.example.com/en/', origin)).toBe('/en/');
  });
  it('falls back to /en/ for cross-origin, missing, or malformed Referers', () => {
    expect(safeReturnPath('https://evil.example.com/steal', origin)).toBe('/en/');
    expect(safeReturnPath(null, origin)).toBe('/en/');
    expect(safeReturnPath('not a url', origin)).toBe('/en/');
  });
  it('rejects a protocol-relative residual path (pathname starting //)', () => {
    // '\\evil.com' backslash-normalizes to a '//evil.com' pathname — emitted in
    // a Location header that would read as a protocol-relative redirect.
    expect(safeReturnPath('https://church.example.com/\\evil.com', origin)).toBe('/en/');
    expect(new URL('https://church.example.com/\\evil.com').pathname.startsWith('//')).toBe(true); // fixture sanity
  });
});
