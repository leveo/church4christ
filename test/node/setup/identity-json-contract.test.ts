import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1 = readFileSync('migrations/0028_member_identity.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0028_member_identity.sql', 'utf8');
const carriers = ['context_json', 'evidence_json', 'counts_json', 'metadata_json'];

describe('identity JSON schema contract', () => {
  it('requires bounded non-NUL JSON objects in both D1 and Postgres migrations', () => {
    for (const column of carriers) {
      expect(d1, column).toMatch(new RegExp(`${column}[\\s\\S]{0,220}instr\\([^)]*char\\(0\\)`, 'i'));
      expect(d1, column).toMatch(new RegExp(`${column}[\\s\\S]{0,220}length\\(CAST\\([^)]*AS BLOB\\)`, 'i'));
      expect(d1, column).toMatch(new RegExp(`${column}[\\s\\S]{0,220}json_valid\\(${column}\\)`, 'i'));
      expect(d1, column).toMatch(new RegExp(`${column}[\\s\\S]{0,260}json_type\\(${column}\\)\\s*=\\s*'object'`, 'i'));
      expect(pg, column).not.toMatch(new RegExp(`position\\(chr\\(0\\) in ${column}\\)`, 'i'));
      expect(pg, column).toMatch(new RegExp(`${column}[\\s\\S]{0,220}octet_length\\(${column}\\)`, 'i'));
      expect(pg, column).toMatch(new RegExp(`${column}[\\s\\S]{0,260}jsonb_typeof\\(${column}::jsonb\\)\\s*=\\s*'object'`, 'i'));
    }
  });

  it('never evaluates chr(0) in PostgreSQL JSON checks because text rejects NUL itself', () => {
    expect(pg).not.toMatch(/position\s*\(\s*chr\s*\(\s*0\s*\)\s+in\s+[a-z_]+\s*\)/i);
  });
});
