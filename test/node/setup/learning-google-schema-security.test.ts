import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1 = readFileSync('migrations/0021_learning_google_receipt_lifecycle.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0021_learning_google_receipt_lifecycle.sql', 'utf8');

describe('Google receipt lifecycle forward-migration security', () => {
  it('keeps D1 and PostgreSQL lifecycle columns in parity without source payload carriers', () => {
    for (const column of [
      'status', 'attempt_count', 'claim_marker', 'claim_expires_at', 'completed_at',
    ]) {
      expect(d1).toMatch(new RegExp(`ADD COLUMN\\s+${column}\\b`, 'i'));
      expect(pg).toMatch(new RegExp(`ADD COLUMN\\s+${column}\\b`, 'i'));
    }
    expect(`${d1}\n${pg}`).not.toMatch(/payload|message_body|token|credential|grade|answer|comment|file_bytes/iu);
  });

  it('reasserts PostgreSQL RLS and revokes PUBLIC plus optional browser roles', () => {
    expect(pg).toMatch(/ALTER TABLE learning_google_notification_receipts ENABLE ROW LEVEL SECURITY/i);
    expect(pg).toMatch(/REVOKE ALL ON TABLE learning_google_notification_receipts FROM PUBLIC/i);
    expect(pg).toMatch(/ARRAY\s*\[\s*'anon'\s*,\s*'authenticated'\s*\]/i);
    expect(pg).toMatch(/IF EXISTS\s*\(SELECT 1 FROM pg_roles WHERE rolname = client_role\)/i);
    expect(pg).not.toMatch(/\bCREATE\s+POLICY\b/i);
  });
});
