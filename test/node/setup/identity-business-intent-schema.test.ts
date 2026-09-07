import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1 = readFileSync('migrations/0034_identity_business_intents.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0034_identity_business_intents.sql', 'utf8');

describe('identity business intent schema contract', () => {
  it('ships paired source/version-bound intents and append-only consumption receipts', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/CREATE TABLE identity_business_intents/i);
      expect(sql).toMatch(/CREATE TABLE identity_team_application_intents/i);
      expect(sql).toMatch(/CREATE TABLE identity_newcomer_intents/i);
      expect(sql).toMatch(/CREATE TABLE identity_business_intent_receipts/i);
      expect(sql).toMatch(/source_record_id[\s\S]*?source_version[\s\S]*?source_digest/i);
      expect(sql).toMatch(/identity_business_intent_insert_guard/i);
      expect(sql).toMatch(/signup_reservation_id[\s\S]*?signup_issuance_token/i);
      expect(sql).toMatch(/identity_business_intent_signup_binding_guard[\s\S]*?normalized_email[\s\S]*?normalized_name/i);
      expect(sql).toMatch(/identity_team_application_intent_immutable/i);
      expect(sql).toMatch(/identity_newcomer_intent_immutable/i);
      expect(sql).toMatch(/identity_business_intent_result_immutable/i);
      expect(sql).toMatch(/identity_business_intent_receipt_guard/i);
      expect(sql).toMatch(/identity_business_intent_receipts_append_only/i);
      const core = sql.match(/CREATE TABLE identity_business_intents[\s\S]*?\n\);/i)?.[0] ?? '';
      const receipt = sql.match(/CREATE TABLE identity_business_intent_receipts[\s\S]*?\n\);/i)?.[0] ?? '';
      expect(`${core}\n${receipt}`).not.toMatch(/\b(email|phone|name|amount|message|answer|provider_payload|token|code)\b/i);
    }
  });

  it('links newcomer submissions directly to one source and one safe provisional subject', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/ALTER TABLE newcomer_submissions ADD COLUMN identity_source_record_id/i);
      expect(sql).toMatch(/identity_source_record_id[\s\S]*?REFERENCES identity_source_records/i);
      expect(sql).toMatch(/identity_newcomer_submission_binding_guard/i);
    }
  });

  it('keeps all business-kind receipt validation branches static', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/kind='team_application'[\s\S]*?team_applications/i);
      expect(sql).toMatch(/kind='newcomer_submission'[\s\S]*?newcomer_submissions/i);
      expect(sql).not.toMatch(/(?:FROM|JOIN|INTO|UPDATE)\s+\$\{/);
    }
  });
});
