import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NEWCOMER_FORM_MAX_BYTES,
  consumeNewcomerPublicRateLimit,
  readNewcomerUrlencodedForm,
} from '../src/lib/newcomerHttp';

function request(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request('https://church.example/en/new-here', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM newcomer_rate_limits').run();
});

describe('bounded Newcomer form reader', () => {
  it('accepts one value per allowed key', async () => {
    const result = await readNewcomerUrlencodedForm(request('name=Alex&consent=true'), ['name', 'consent']);
    expect(result).toEqual({ ok: true, fields: { name: 'Alex', consent: 'true' } });
  });

  it('rejects wrong MIME, duplicate/unknown keys, fatal UTF-8, and actual oversized streams', async () => {
    expect(await readNewcomerUrlencodedForm(request('name=Alex', { 'content-type': 'text/plain' }), ['name']))
      .toMatchObject({ ok: false, reason: 'unsupported_media_type' });
    expect(await readNewcomerUrlencodedForm(request('name=A&name=B'), ['name']))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await readNewcomerUrlencodedForm(request('private=answer'), ['name']))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await readNewcomerUrlencodedForm(request(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x3d, 0xff])), ['name']))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await readNewcomerUrlencodedForm(request('x'.repeat(NEWCOMER_FORM_MAX_BYTES + 1)), ['name']))
      .toMatchObject({ ok: false, reason: 'too_large' });
  });
});

describe('public DB-backed Newcomer rate limit', () => {
  it('fails closed without the secret and performs no write', async () => {
    expect(await consumeNewcomerPublicRateLimit(env.DB, {
      backend: 'd1', secret: undefined, email: 'alex@example.test', phone: null,
      cfConnectingIp: '203.0.113.4', now: '2026-08-12 19:07:00',
    })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_rate_limits').first<number>('n')).toBe(0);
  });

  it('stores only keyed hashes and limits normalized contact to five per ten-minute window', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await consumeNewcomerPublicRateLimit(env.DB, {
        backend: 'd1', secret: 'rate-limit-test-secret', email: 'Alex@Example.Test ', phone: null,
        cfConnectingIp: '203.0.113.4', now: '2026-08-12 19:07:00',
      })).toEqual({ ok: true });
    }
    expect(await consumeNewcomerPublicRateLimit(env.DB, {
      backend: 'd1', secret: 'rate-limit-test-secret', email: 'alex@example.test', phone: null,
      cfConnectingIp: '203.0.113.5', now: '2026-08-12 19:08:00',
    })).toEqual({ ok: false, reason: 'limited' });
    const rows = await env.DB.prepare('SELECT bucket_hash,window_start,attempts,expires_at FROM newcomer_rate_limits').all<Record<string, unknown>>();
    expect(rows.results.every((row) => /^[0-9a-f]{64}$/.test(String(row.bucket_hash)))).toBe(true);
    expect(JSON.stringify(rows.results)).not.toMatch(/alex|example|203\.0\.113|rate-limit-test-secret/i);
  });

  it('uses a shared five-attempt unknown-IP bucket and ignores forwarded IP', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await consumeNewcomerPublicRateLimit(env.DB, {
        backend: 'd1', secret: 'rate-limit-test-secret', email: `guest${attempt}@example.test`, phone: null,
        cfConnectingIp: null, now: '2026-08-12 19:07:00',
      })).toEqual({ ok: true });
    }
    expect(await consumeNewcomerPublicRateLimit(env.DB, {
      backend: 'd1', secret: 'rate-limit-test-secret', email: 'another@example.test', phone: null,
      cfConnectingIp: null, now: '2026-08-12 19:07:00',
    })).toEqual({ ok: false, reason: 'limited' });
  });
});
