import type { AppDb } from './appDb';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type IdentityRecoveryKeyEnv = Readonly<{
  IDENTITY_RECOVERY_KEY_SECRET?: string;
  IDENTITY_RECOVERY_KEY_ID?: string;
}>;

export type IdentityRecoveryKeyMaterial = Readonly<{ secret: string; keyId: string }>;

function configuration(env: IdentityRecoveryKeyEnv): IdentityRecoveryKeyMaterial {
  const secret = env.IDENTITY_RECOVERY_KEY_SECRET;
  const keyId = env.IDENTITY_RECOVERY_KEY_ID;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 1024 || /[\s\0-\x1f\x7f]/u.test(secret)) {
    throw new Error('identity_recovery_key_secret_invalid');
  }
  if (typeof keyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(keyId)) {
    throw new Error('identity_recovery_key_id_invalid');
  }
  return Object.freeze({ secret, keyId });
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function identityRecoveryKeyMaterial(db: AppDb, env: IdentityRecoveryKeyEnv): Promise<IdentityRecoveryKeyMaterial> {
  const material = configuration(env);
  const verificationTag = await hmac(material.secret, `identity-recovery-key-config:v1\0${material.keyId}`);
  let pinned = await db.prepare(`SELECT key_id,algorithm_version,verification_tag FROM identity_recovery_key_config
    WHERE singleton_id=1`).first<{ key_id: string; algorithm_version: number; verification_tag: string }>();
  if (!pinned) {
    try {
      await db.prepare(`INSERT INTO identity_recovery_key_config(singleton_id,key_id,algorithm_version,verification_tag)
        VALUES(1,?1,1,?2)`).bind(material.keyId, verificationTag).run();
    } catch { /* A concurrent initializer may have pinned the singleton. */ }
    pinned = await db.prepare(`SELECT key_id,algorithm_version,verification_tag FROM identity_recovery_key_config
      WHERE singleton_id=1`).first<{ key_id: string; algorithm_version: number; verification_tag: string }>();
  }
  if (!pinned || pinned.key_id !== material.keyId || pinned.algorithm_version !== 1 || pinned.verification_tag !== verificationTag) {
    throw new Error('identity_recovery_key_configuration_mismatch');
  }
  return material;
}

export async function ensureIdentityRecoveryKeyConfiguration(db: AppDb, env: IdentityRecoveryKeyEnv): Promise<void> {
  await identityRecoveryKeyMaterial(db, env);
}

export function hasValidIdentityRecoveryKeyConfiguration(secret: unknown, keyId: unknown): boolean {
  return typeof secret === 'string' && secret.length >= 32 && secret.length <= 1024 && !/[\s\0-\x1f\x7f]/u.test(secret)
    && typeof keyId === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/u.test(keyId);
}

export function hmacIdentityRecoveryValue(material: IdentityRecoveryKeyMaterial, domain: string, value: string): Promise<string> {
  return hmac(material.secret, `identity-recovery:v1\0${material.keyId}\0${domain}\0${value}`);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64url(value: string): ArrayBuffer {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

async function payloadKey(material: IdentityRecoveryKeyMaterial): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`identity-recovery-payload:v1\0${material.keyId}\0${material.secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptIdentityRecoveryPayload(material: IdentityRecoveryKeyMaterial, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await payloadKey(material), encoder.encode(value));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function decryptIdentityRecoveryPayload(material: IdentityRecoveryKeyMaterial, keyId: string,
  ciphertext: string): Promise<string> {
  if (keyId !== material.keyId) throw new Error('identity_recovery_key_configuration_mismatch');
  const [version, iv, payload] = ciphertext.split('.');
  if (version !== 'v1' || !iv || !payload) throw new Error('identity_recovery_outbox_payload_invalid');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(iv) }, await payloadKey(material), fromBase64url(payload));
  return decoder.decode(decrypted);
}
