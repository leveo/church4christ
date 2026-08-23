// Post-0030 legacy email-change APIs are deliberately inert. Contact ownership
// must flow through identityAccount's step-up + OTP proof instead.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeToken, createEmailChangeToken, peekToken, sha256Hex } from '../src/lib/auth';
import { consumeEmailChange, peekEmailChange, requestEmailChange } from '../src/lib/emailChange';

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM tokens'), env.DB.prepare('DELETE FROM people')]);
  await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(1,'Legacy Test','legacy@example.test')").run();
});

describe('legacy email-change cutover', () => {
  it('fails every old API closed without creating a token, pending address, or direct email mutation', async () => {
    await expect(createEmailChangeToken(env.DB, 1)).rejects.toThrow('identity_legacy_email_change_retired');
    expect(await requestEmailChange(env.DB, 1, 'attacker@example.test')).toEqual({ error: 'retired' });
    expect(await peekEmailChange(env.DB, 'old-raw-token')).toBeNull();
    expect(await consumeEmailChange(env.DB, 'old-raw-token')).toEqual({ error: 'invalid' });
    expect(await peekToken(env.DB, 'old-raw-token', 'email_change')).toBeNull();
    expect(await consumeToken(env.DB, 'old-raw-token', 'email_change')).toBeNull();
    expect(await env.DB.prepare('SELECT email,pending_email FROM people WHERE id=1').first<{ email: string; pending_email: string | null }>())
      .toEqual({ email: 'legacy@example.test', pending_email: null });
    expect(await env.DB.prepare("SELECT count(*) n FROM tokens WHERE purpose='email_change'").first<number>('n')).toBe(0);
  });

  it('has durable D1 guards for insert and update bypasses of both retired fields', async () => {
    await expect(env.DB.prepare("INSERT INTO tokens(person_id,token_hash,purpose,expires_at) VALUES(1,?1,'email_change','2099-01-01 00:00:00')")
      .bind(await sha256Hex('legacy-direct-insert')).run()).rejects.toThrow(/identity_legacy_email_change_retired/);
    await env.DB.prepare("INSERT INTO tokens(person_id,token_hash,purpose,expires_at) VALUES(1,?1,'login','2099-01-01 00:00:00')")
      .bind(await sha256Hex('legacy-direct-update')).run();
    await expect(env.DB.prepare("UPDATE tokens SET purpose='email_change' WHERE token_hash=?1")
      .bind(await sha256Hex('legacy-direct-update')).run()).rejects.toThrow(/identity_legacy_email_change_retired/);
    await expect(env.DB.prepare("INSERT INTO people(id,display_name,email,pending_email) VALUES(2,'Legacy Insert','legacy-insert@example.test','attacker@example.test')").run())
      .rejects.toThrow(/identity_legacy_pending_email_retired/);
    await expect(env.DB.prepare("UPDATE people SET pending_email='attacker@example.test' WHERE id=1").run())
      .rejects.toThrow(/identity_legacy_pending_email_retired/);
  });
});
