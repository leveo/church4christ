import { describe, expect, it } from 'vitest';
import {
  LEARNING_CREDENTIAL_ENVELOPE_VERSION,
  LearningCredentialError,
  decryptLearningCredential,
  encryptLearningCredential,
  importLearningCredentialKeyRing,
  learningCredentialNeedsRotation,
  reencryptLearningCredential,
} from '../src/lib/learningCredentials';

const b64 = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const secret = (currentVersion = 2): string => JSON.stringify({
  currentVersion,
  keys: { 1: b64(0x11), 2: b64(0x22) },
});

const plaintext = new TextEncoder().encode(JSON.stringify({ accessToken: 'canvas-token-private' }));
const aadMagic = new TextEncoder().encode('church4christ.learning.credential');

function legacyAad(
  provider: 'google_classroom' | 'canvas',
  connectionId: number,
  envelopeVersion: 1 | 2,
  keyVersion: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(aadMagic.byteLength + 13);
  bytes.set(aadMagic);
  const view = new DataView(bytes.buffer);
  let offset = aadMagic.byteLength;
  view.setUint32(offset, envelopeVersion, false); offset += 4;
  view.setUint32(offset, keyVersion, false); offset += 4;
  view.setUint8(offset, provider === 'google_classroom' ? 1 : 2); offset += 1;
  view.setUint32(offset, connectionId, false);
  return bytes;
}

function canonicalV2Aad(
  provider: 'google_classroom' | 'canvas',
  connectionId: number,
  keyVersion: number,
  expiresAt: string | null,
): Uint8Array<ArrayBuffer> {
  const base = legacyAad(provider, connectionId, 2, keyVersion);
  const expiry = expiresAt === null ? new Uint8Array() : new TextEncoder().encode(expiresAt);
  const bytes = new Uint8Array(base.byteLength + 5 + expiry.byteLength);
  bytes.set(base);
  const view = new DataView(bytes.buffer);
  view.setUint8(base.byteLength, expiresAt === null ? 0 : 1);
  view.setUint32(base.byteLength + 1, expiry.byteLength, false);
  bytes.set(expiry, base.byteLength + 5);
  return bytes;
}

async function fixtureCiphertext(
  keyByte: number,
  nonce: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(32).fill(keyByte), { name: 'AES-GCM' }, false, ['encrypt'],
  );
  return new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext,
  ));
}

async function safeFailure(run: () => Promise<unknown>): Promise<void> {
  let error: unknown;
  try { await run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LearningCredentialError);
  expect(String(error)).toBe('LearningCredentialError: learning_credential_unavailable');
  expect(JSON.stringify(error)).not.toMatch(/canvas-token-private|ciphertext|nonce|key/i);
}

describe('Learning credential key-ring import', () => {
  it('accepts only an exact, bounded JSON key ring with canonical 32-byte base64 keys', async () => {
    const ring = await importLearningCredentialKeyRing(secret());
    expect(ring.currentVersion).toBe(2);

    for (const invalid of [
      '', 'null', '{}', '{"currentVersion":0,"keys":{}}',
      JSON.stringify({ currentVersion: 1, keys: { 1: b64(1) }, extra: true }),
      JSON.stringify({ currentVersion: 1, keys: { 1: 'not base64' } }),
      JSON.stringify({ currentVersion: 1, keys: { 1: btoa('short') } }),
      JSON.stringify({ currentVersion: 2, keys: { 1: b64(1) } }),
      JSON.stringify({ currentVersion: 1, keys: { 0: b64(1), 1: b64(1) } }),
      JSON.stringify({ currentVersion: 1, keys: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, b64(i)])) }),
      ` ${JSON.stringify({ currentVersion: 1, keys: { 1: b64(1) } })}`,
      `{"currentVersion":1,"currentVersion":2,"keys":{"1":"${b64(1)}","2":"${b64(2)}"}}`,
    ]) {
      await expect(importLearningCredentialKeyRing(invalid)).rejects.toThrow('learning_credential_keyring_invalid');
    }
  });
});

describe('Learning AES-256-GCM credential envelope', () => {
  it('uses a fresh 12-byte nonce and binds version, key version, provider, and connection id in AAD', async () => {
    const ring = await importLearningCredentialKeyRing(secret());
    const first = await encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 41, plaintext, expiresAt: null,
    });
    const second = await encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 41, plaintext, expiresAt: null,
    });

    expect(LEARNING_CREDENTIAL_ENVELOPE_VERSION).toBe(2);
    expect(first).toMatchObject({ algorithm: 'AES-256-GCM', keyVersion: 2, envelopeVersion: 2, expiresAt: null });
    expect(first.nonce).toHaveLength(12);
    expect(first.ciphertext).toHaveLength(plaintext.byteLength + 16);
    expect([...first.nonce]).not.toEqual([...second.nonce]);
    expect([...first.ciphertext]).not.toEqual([...second.ciphertext]);
    expect([...await decryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 41, envelope: first,
    })]).toEqual([...plaintext]);

    for (const scope of [
      { provider: 'google_classroom' as const, connectionId: 41 },
      { provider: 'canvas' as const, connectionId: 42 },
    ]) await safeFailure(() => decryptLearningCredential(ring, { ...scope, envelope: first }));

    const wrongRing = await importLearningCredentialKeyRing(JSON.stringify({
      currentVersion: 2, keys: { 2: b64(0x33) },
    }));
    await safeFailure(() => decryptLearningCredential(wrongRing, {
      provider: 'canvas', connectionId: 41, envelope: first,
    }));
  });

  it('fails closed for unknown versions, missing keys, tamper, truncation, invalid bounds, and never discloses input', async () => {
    const ring = await importLearningCredentialKeyRing(secret());
    const envelope = await encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 41, plaintext, expiresAt: null,
    });
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice() };
    tampered.ciphertext[0] ^= 1;
    const invalids = [
      { ...envelope, envelopeVersion: 3 },
      { ...envelope, keyVersion: 999 },
      tampered,
      { ...envelope, ciphertext: envelope.ciphertext.slice(0, 15) },
      { ...envelope, nonce: envelope.nonce.slice(0, 11) },
      { ...envelope, algorithm: 'AES-CBC' },
    ];
    for (const invalid of invalids) {
      await safeFailure(() => decryptLearningCredential(ring, {
        provider: 'canvas', connectionId: 41, envelope: invalid as never,
      }));
    }
    for (const bytes of [new Uint8Array(), new Uint8Array(16_369)]) {
      await safeFailure(() => encryptLearningCredential(ring, {
        provider: 'canvas', connectionId: 41, plaintext: bytes, expiresAt: null,
      }));
    }
  });

  it('decrypts legacy v1 and the canonical v2 null-marker/length-prefixed expiry encoding', async () => {
    const ring = await importLearningCredentialKeyRing(secret(1));
    const nonce = new Uint8Array(12).fill(0x5a);
    const expiresAt = '2027-01-01T00:00:00.123Z';
    const fixtures = [
      {
        envelopeVersion: 1 as const,
        expiresAt,
        aad: legacyAad('canvas', 17, 1, 1),
      },
      {
        envelopeVersion: 2 as const,
        expiresAt: null,
        aad: canonicalV2Aad('canvas', 17, 1, null),
      },
      {
        envelopeVersion: 2 as const,
        expiresAt,
        aad: canonicalV2Aad('canvas', 17, 1, expiresAt),
      },
    ];
    for (const fixture of fixtures) {
      const envelope = {
        ciphertext: await fixtureCiphertext(0x11, nonce, fixture.aad),
        nonce,
        algorithm: 'AES-256-GCM' as const,
        keyVersion: 1,
        envelopeVersion: fixture.envelopeVersion,
        expiresAt: fixture.expiresAt,
      };
      expect([...await decryptLearningCredential(ring, {
        provider: 'canvas', connectionId: 17, envelope,
      })]).toEqual([...plaintext]);
    }

    const legacy = {
      ciphertext: await fixtureCiphertext(0x11, nonce, legacyAad('canvas', 17, 1, 1)),
      nonce,
      algorithm: 'AES-256-GCM' as const,
      keyVersion: 1,
      envelopeVersion: 1 as const,
      expiresAt,
    };
    expect(learningCredentialNeedsRotation(ring, legacy)).toBe(true);
    const migrated = await reencryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 17, envelope: legacy,
    });
    expect(migrated).toMatchObject({ envelopeVersion: 2, keyVersion: 1, expiresAt });
    expect([...await decryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 17, envelope: migrated,
    })]).toEqual([...plaintext]);
  });

  it('authenticates the exact v2 expiry, including null, against deletion, changes, extension, and shortening', async () => {
    const ring = await importLearningCredentialKeyRing(secret());
    const expiresAt = '2027-01-01T00:00:00.123Z';
    const envelope = await encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 41, plaintext, expiresAt,
    });
    expect(envelope.envelopeVersion).toBe(2);
    const deleted = {
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      algorithm: envelope.algorithm,
      keyVersion: envelope.keyVersion,
      envelopeVersion: envelope.envelopeVersion,
    };
    for (const invalid of [
      deleted,
      { ...envelope, expiresAt: null },
      { ...envelope, expiresAt: '2028-01-01T00:00:00.123Z' },
      { ...envelope, expiresAt: '2027-01-01T00:00:00.123456Z' },
      { ...envelope, expiresAt: '2027-01-01T00:00:00Z' },
    ]) await safeFailure(() => decryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 41, envelope: invalid as never,
    }));

    const noExpiry = await encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 42, plaintext, expiresAt: null,
    });
    await safeFailure(() => decryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 42,
      envelope: { ...noExpiry, expiresAt: '2027-01-01T00:00:00Z' },
    }));
  });

  it('detects old keys and re-encrypts under the current key with fresh nonce', async () => {
    const oldRing = await importLearningCredentialKeyRing(secret(1));
    const oldEnvelope = await encryptLearningCredential(oldRing, {
      provider: 'canvas', connectionId: 7, plaintext, expiresAt: '2027-01-01T00:00:00Z',
    });
    const ring = await importLearningCredentialKeyRing(secret(2));
    expect(learningCredentialNeedsRotation(ring, oldEnvelope)).toBe(true);
    const rotated = await reencryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 7, envelope: oldEnvelope,
    });
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.envelopeVersion).toBe(2);
    expect(rotated.expiresAt).toBe(oldEnvelope.expiresAt);
    expect([...rotated.nonce]).not.toEqual([...oldEnvelope.nonce]);
    expect(new TextDecoder().decode(await decryptLearningCredential(ring, {
      provider: 'canvas', connectionId: 7, envelope: rotated,
    }))).toContain('canvas-token-private');
    expect(learningCredentialNeedsRotation(ring, rotated)).toBe(false);
  });
});
