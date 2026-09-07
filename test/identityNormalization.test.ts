import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizeName, normalizePhone } from '../src/lib/identityNormalize';

describe('identity normalization', () => {
  it('normalizes email with NFC and lowercase while retaining mailbox semantics', () => {
    expect(normalizeEmail('  Te\u0301.st+News@Example.COM  ')).toBe('té.st+news@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('name@localhost')).toBeNull();
  });

  it('accepts explicit E.164 phone numbers and rejects ambiguous national numbers without context', () => {
    expect(normalizePhone(' +1 (415) 555-2671 ')).toBe('+14155552671');
    expect(normalizePhone('415 555 2671')).toBeNull();
    expect(normalizePhone('415 555 2671', { defaultCountryCode: '1' })).toBe('+14155552671');
    expect(normalizePhone('0044 20 7946 0018')).toBeNull();
  });

  it('normalizes names without transliterating their script', () => {
    expect(normalizeName('  Dr.  José—Silva  ')).toBe('dr josé silva');
    expect(normalizeName(' 王　小明 ')).toBe('王 小明');
  });

  it('rejects NUL, C0, and DEL controls before trimming or normalization', () => {
    for (const control of ['\0', '\n', '\u001f', '\u007f']) {
      expect(normalizeEmail(`${control}member@example.test`)).toBeNull();
      expect(normalizeName(`${control}Member`)).toBeNull();
    }
  });
});
