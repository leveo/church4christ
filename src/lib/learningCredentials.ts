import type { LearningProviderKind } from './learningModel';

export const LEARNING_CREDENTIAL_ALGORITHM = 'AES-256-GCM' as const;
export const LEARNING_CREDENTIAL_ENVELOPE_VERSION = 1 as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 16_384;
const MAX_PLAINTEXT_BYTES = MAX_CIPHERTEXT_BYTES - TAG_BYTES;
const MAX_DB_INTEGER = 2_147_483_647;
const MAX_KEYS = 8;
const AAD_MAGIC = new TextEncoder().encode('church4christ.learning.credential');

export interface LearningCredentialEnvelope {
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly algorithm: typeof LEARNING_CREDENTIAL_ALGORITHM;
  readonly keyVersion: number;
  readonly envelopeVersion: typeof LEARNING_CREDENTIAL_ENVELOPE_VERSION;
  readonly expiresAt: string | null;
}

export class LearningCredentialError extends Error {
  readonly code = 'learning_credential_unavailable' as const;
  constructor() {
    super('learning_credential_unavailable');
    this.name = 'LearningCredentialError';
  }
}

export class LearningCredentialConfigError extends Error {
  readonly code = 'learning_credential_keyring_invalid' as const;
  constructor() {
    super('learning_credential_keyring_invalid');
    this.name = 'LearningCredentialConfigError';
  }
}

function configInvalid(): never { throw new LearningCredentialConfigError(); }
function unavailable(): never { throw new LearningCredentialError(); }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) configInvalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) configInvalid();
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) configInvalid();
  return value as Record<string, unknown>;
}

function dbInteger(value: unknown, minimum = 1): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > MAX_DB_INTEGER) unavailable();
  return value as number;
}

function providerCode(provider: unknown): 1 | 2 {
  if (provider === 'google_classroom') return 1;
  if (provider === 'canvas') return 2;
  return unavailable();
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function decodeCanonicalBase64(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(value)) configInvalid();
  let decoded: string;
  try { decoded = atob(value); } catch { return configInvalid(); }
  if (decoded.length !== 32) configInvalid();
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  if (btoa(String.fromCharCode(...bytes)) !== value) configInvalid();
  return bytes;
}

function timestampOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string'
    || value.length < 19
    || new TextEncoder().encode(value).byteLength > 40
    || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
  ) unavailable();
  return value;
}

function additionalData(
  provider: LearningProviderKind,
  connectionId: number,
  envelopeVersion: number,
  keyVersion: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(AAD_MAGIC.byteLength + 13);
  bytes.set(AAD_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  let offset = AAD_MAGIC.byteLength;
  view.setUint32(offset, envelopeVersion, false); offset += 4;
  view.setUint32(offset, keyVersion, false); offset += 4;
  view.setUint8(offset, providerCode(provider)); offset += 1;
  view.setUint32(offset, connectionId, false);
  return bytes;
}

class CredentialKeyRing {
  readonly currentVersion: number;
  readonly #keys: ReadonlyMap<number, CryptoKey>;

  constructor(currentVersion: number, keys: ReadonlyMap<number, CryptoKey>) {
    this.currentVersion = currentVersion;
    this.#keys = keys;
    Object.freeze(this);
  }

  has(version: number): boolean { return this.#keys.has(version); }

  async encrypt(
    version: number,
    nonce: Uint8Array<ArrayBuffer>,
    aad: Uint8Array<ArrayBuffer>,
    plaintext: Uint8Array<ArrayBuffer>,
  ): Promise<ArrayBuffer> {
    const key = this.#keys.get(version);
    if (!key) unavailable();
    try {
      return await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        key,
        plaintext,
      );
    } catch { return unavailable(); }
  }

  async decrypt(
    version: number,
    nonce: Uint8Array<ArrayBuffer>,
    aad: Uint8Array<ArrayBuffer>,
    ciphertext: Uint8Array<ArrayBuffer>,
  ): Promise<ArrayBuffer> {
    const key = this.#keys.get(version);
    if (!key) unavailable();
    try {
      return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        key,
        ciphertext,
      );
    } catch { return unavailable(); }
  }
}

export type LearningCredentialKeyRing = CredentialKeyRing;

export async function importLearningCredentialKeyRing(secret: string): Promise<LearningCredentialKeyRing> {
  try {
    if (typeof secret !== 'string' || secret.length < 1 || secret.length > 4_096) configInvalid();
    let decoded: unknown;
    try { decoded = JSON.parse(secret); } catch { return configInvalid(); }
    const root = exactRecord(decoded, ['currentVersion', 'keys']);
    if (!Number.isInteger(root.currentVersion) || (root.currentVersion as number) < 1 || (root.currentVersion as number) > MAX_DB_INTEGER) configInvalid();
    const currentVersion = root.currentVersion as number;
    if (root.keys === null || typeof root.keys !== 'object' || Array.isArray(root.keys)) configInvalid();
    const rawKeys = root.keys as Record<string, unknown>;
    if (Object.getPrototypeOf(rawKeys) !== Object.prototype) configInvalid();
    const entries = Object.entries(rawKeys);
    if (entries.length < 1 || entries.length > MAX_KEYS) configInvalid();
    if (secret !== JSON.stringify({ currentVersion, keys: rawKeys })) configInvalid();
    const imported = new Map<number, CryptoKey>();
    for (const [rawVersion, encoded] of entries) {
      if (!/^[1-9]\d*$/.test(rawVersion)) configInvalid();
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version > MAX_DB_INTEGER || imported.has(version)) configInvalid();
      const key = await crypto.subtle.importKey(
        'raw', decodeCanonicalBase64(encoded), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
      );
      imported.set(version, key);
    }
    if (!imported.has(currentVersion)) configInvalid();
    return new CredentialKeyRing(currentVersion, imported);
  } catch (error) {
    if (error instanceof LearningCredentialConfigError) throw error;
    throw new LearningCredentialConfigError();
  }
}

interface EncryptLearningCredentialInput {
  readonly provider: LearningProviderKind;
  readonly connectionId: number;
  readonly plaintext: Uint8Array;
  readonly expiresAt: string | null;
}

function envelopeCopy(value: unknown): LearningCredentialEnvelope {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable();
    const actual = Object.keys(value as object).sort();
    const expected = ['algorithm', 'ciphertext', 'envelopeVersion', 'expiresAt', 'keyVersion', 'nonce'].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) unavailable();
    const row = value as Record<string, unknown>;
    if (row.algorithm !== LEARNING_CREDENTIAL_ALGORITHM || row.envelopeVersion !== LEARNING_CREDENTIAL_ENVELOPE_VERSION) unavailable();
    const keyVersion = dbInteger(row.keyVersion);
    if (!(row.ciphertext instanceof Uint8Array) || row.ciphertext.byteLength < TAG_BYTES || row.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) unavailable();
    if (!(row.nonce instanceof Uint8Array) || row.nonce.byteLength !== NONCE_BYTES) unavailable();
    return {
      ciphertext: ownedBytes(row.ciphertext),
      nonce: ownedBytes(row.nonce),
      algorithm: LEARNING_CREDENTIAL_ALGORITHM,
      keyVersion,
      envelopeVersion: LEARNING_CREDENTIAL_ENVELOPE_VERSION,
      expiresAt: timestampOrNull(row.expiresAt),
    };
  } catch (error) {
    if (error instanceof LearningCredentialError) throw error;
    return unavailable();
  }
}

export async function encryptLearningCredential(
  ring: LearningCredentialKeyRing,
  input: EncryptLearningCredentialInput,
): Promise<LearningCredentialEnvelope> {
  try {
    const code = providerCode(input.provider);
    void code;
    const connectionId = dbInteger(input.connectionId);
    if (!(input.plaintext instanceof Uint8Array) || input.plaintext.byteLength < 1 || input.plaintext.byteLength > MAX_PLAINTEXT_BYTES) unavailable();
    const expiresAt = timestampOrNull(input.expiresAt);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const keyVersion = ring.currentVersion;
    const aad = additionalData(input.provider, connectionId, LEARNING_CREDENTIAL_ENVELOPE_VERSION, keyVersion);
    const ciphertext = new Uint8Array(await ring.encrypt(keyVersion, nonce, aad, ownedBytes(input.plaintext)));
    if (ciphertext.byteLength < TAG_BYTES || ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) unavailable();
    return {
      ciphertext, nonce, algorithm: LEARNING_CREDENTIAL_ALGORITHM, keyVersion,
      envelopeVersion: LEARNING_CREDENTIAL_ENVELOPE_VERSION, expiresAt,
    };
  } catch (error) {
    if (error instanceof LearningCredentialError) throw error;
    throw new LearningCredentialError();
  }
}

interface DecryptLearningCredentialInput {
  readonly provider: LearningProviderKind;
  readonly connectionId: number;
  readonly envelope: LearningCredentialEnvelope;
}

export async function decryptLearningCredential(
  ring: LearningCredentialKeyRing,
  input: DecryptLearningCredentialInput,
): Promise<Uint8Array> {
  try {
    providerCode(input.provider);
    const connectionId = dbInteger(input.connectionId);
    const envelope = envelopeCopy(input.envelope);
    if (!ring.has(envelope.keyVersion)) unavailable();
    const aad = additionalData(input.provider, connectionId, envelope.envelopeVersion, envelope.keyVersion);
    const plaintext = new Uint8Array(await ring.decrypt(
      envelope.keyVersion, envelope.nonce, aad, envelope.ciphertext,
    ));
    if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) unavailable();
    return plaintext;
  } catch (error) {
    if (error instanceof LearningCredentialError) throw error;
    throw new LearningCredentialError();
  }
}

export function learningCredentialNeedsRotation(
  ring: LearningCredentialKeyRing,
  rawEnvelope: LearningCredentialEnvelope,
): boolean {
  const envelope = envelopeCopy(rawEnvelope);
  if (!ring.has(envelope.keyVersion)) unavailable();
  return envelope.keyVersion !== ring.currentVersion;
}

export async function reencryptLearningCredential(
  ring: LearningCredentialKeyRing,
  input: DecryptLearningCredentialInput,
): Promise<LearningCredentialEnvelope> {
  const envelope = envelopeCopy(input.envelope);
  const plaintext = await decryptLearningCredential(ring, { ...input, envelope });
  return encryptLearningCredential(ring, {
    provider: input.provider,
    connectionId: input.connectionId,
    plaintext,
    expiresAt: envelope.expiresAt,
  });
}
