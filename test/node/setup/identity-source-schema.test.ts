import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1 = readFileSync('migrations/0031_identity_source_records.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0031_identity_source_records.sql', 'utf8');
const gateway = readFileSync('src/lib/identityGateway.ts', 'utf8');
const devVars = readFileSync('.dev.vars.example', 'utf8');
const wranglerTemplate = readFileSync('config/wrangler.template.jsonc', 'utf8');
const setupSecrets = readFileSync('scripts/setup/secrets.mjs', 'utf8');
const deployDocs = readFileSync('docs/deploy.md', 'utf8');

describe('identity source schema contract', () => {
  it('ships paired source, operation, and append-only receipt ledgers without raw PII carriers', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/CREATE TABLE identity_source_key_config/i);
      expect(sql).toMatch(/CREATE TABLE identity_source_records/i);
      expect(sql).toMatch(/CREATE TABLE identity_claim_operations/i);
      expect(sql).toMatch(/CREATE TABLE identity_source_attachment_receipts/i);
      expect(sql).toMatch(/CREATE TABLE identity_source_attachment_commits/i);
      expect(sql).toMatch(/CREATE TABLE identity_source_provisional_operations/i);
      expect(sql).toMatch(/CREATE TABLE identity_source_provisional_receipts/i);
      expect(sql).toMatch(/identity_source_provisional_operations_append_only/i);
      expect(sql).toMatch(/identity_source_attachment_receipts_append_only/i);
      expect(sql).toMatch(/identity_source_attachment_receipt_guard/i);
      expect(sql).toMatch(/identity_source_key_config_immutable_update/i);
      expect(sql).toMatch(/identity_source_key_config_immutable_delete/i);
      const sourceTable = sql.match(/CREATE TABLE identity_source_records[\s\S]*?\n\);/i)?.[0] ?? '';
      const receiptTable = sql.match(/CREATE TABLE identity_source_attachment_receipts[\s\S]*?\n\);/i)?.[0] ?? '';
      const provisionalTable = sql.match(/CREATE TABLE identity_source_provisional_operations[\s\S]*?\n\);/i)?.[0] ?? '';
      const provisionalReceiptTable = sql.match(/CREATE TABLE identity_source_provisional_receipts[\s\S]*?\n\);/i)?.[0] ?? '';
      const attachmentCommitTable = sql.match(/CREATE TABLE identity_source_attachment_commits[\s\S]*?\n\);/i)?.[0] ?? '';
      expect(`${sourceTable}\n${receiptTable}\n${provisionalTable}\n${provisionalReceiptTable}\n${attachmentCommitTable}`)
        .not.toMatch(/\b(email|phone|name|amount|note|answer|provider_payload|ip_address)\b/i);
    }
    expect(d1).toMatch(/source_record_key[\s\S]*?length\(source_record_key\)=64[\s\S]*?NOT GLOB '\*\[\^0-9a-f\]\*'/i);
    expect(pg).toMatch(/source_record_key[\s\S]*?octet_length\(source_record_key\)=64[\s\S]*?\^\[0-9a-f\]\{64\}\$/i);
  });

  it('serializes contact and source rows and uses dialect-correct NULL-safe immutable links', () => {
    expect(pg).toMatch(/PERFORM 1 FROM identity_source_records WHERE id=NEW\.source_record_id FOR UPDATE/i);
    expect(pg).toMatch(/PERFORM 1 FROM identity_observations WHERE id=\(SELECT observation_id FROM identity_source_records WHERE id=NEW\.source_record_id\) FOR UPDATE/i);
    expect(pg).toMatch(/PERFORM pg_advisory_xact_lock\(NEW\.person_id\)/i);
    expect(pg).toMatch(/PERFORM 1 FROM people WHERE id=NEW\.person_id FOR UPDATE/i);
    expect(pg).toMatch(/PERFORM 1 FROM campus_memberships WHERE person_id=NEW\.person_id AND campus_id=NEW\.campus_id FOR UPDATE/i);
    for (const name of [
      'identity_claim_person_contact_insert_guard', 'identity_claim_person_contact_reactivation_guard',
      'identity_claim_household_contact_insert_guard', 'identity_claim_household_contact_reactivation_guard',
    ]) {
      const fn = pg.match(new RegExp(`FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$;`, 'i'))?.[0] ?? '';
      expect(fn).toMatch(/pg_advisory_xact_lock\(NEW\.contact_point_id\)/i);
    }
    expect(d1).toMatch(/OLD\.linked_person_id IS NOT NULL AND \([\s\S]*?NEW\.linked_person_id IS NOT OLD\.linked_person_id/i);
    expect(pg).toMatch(/OLD\.linked_person_id IS NOT NULL AND \([\s\S]*?NEW\.linked_person_id IS DISTINCT FROM OLD\.linked_person_id/i);
    for (const sql of [d1, pg]) {
      const guard = sql.match(/identity_source_attachment_receipt_guard[\s\S]*?(?:CREATE TRIGGER identity_source_attachment_receipt_guard|BEGIN SELECT RAISE\(ABORT,'identity_source_attachment_proof_invalid'\); END;)/i)?.[0] ?? '';
      expect(guard).toMatch(/s\.provisional_person_id IS NULL/i);
      const provisionalGuard = sql.match(/identity_source_provisional_guard[\s\S]*?(?:CREATE TRIGGER identity_source_provisional_guard|identity_source_provisional_invalid)/i)?.[0] ?? '';
      expect(provisionalGuard).toMatch(/person_contact_links[\s\S]*?person_id\s*(?:<>|!=)\s*NEW\.provisional_person_id/i);
      expect(provisionalGuard).toMatch(/household_contact_links[\s\S]*?contact_point_id/i);
    }
    const provisionalOperationGuard = pg.match(/FUNCTION identity_source_provisional_operation_insert_guard\(\)[\s\S]*?\$\$;/i)?.[0] ?? '';
    expect(provisionalOperationGuard).toMatch(/pg_advisory_xact_lock/i);
    expect(provisionalOperationGuard).toMatch(/normalized_email[\s\S]*?normalized_phone/i);
  });

  it('rejects forged source bindings and derives lookup keys with a secret-keyed domain-separated HMAC', () => {
    for (const sql of [d1, pg]) {
      const insertGuard = sql.match(/identity_source_records_insert_unlinked[\s\S]*?(?:END;|\$\$;)/i)?.[0] ?? '';
      expect(insertGuard).toMatch(/NEW\.provisional_person_id IS NOT NULL/i);
      expect(insertGuard).toMatch(/o\.campus_id=NEW\.campus_id/i);
      expect(insertGuard).toMatch(/o\.source=NEW\.source/i);
      expect(insertGuard).toMatch(/o\.source_key=NEW\.source_record_key/i);
      expect(insertGuard).toMatch(/o\.status='provisional'/i);
      expect(insertGuard).toMatch(/o\.linked_person_id IS NULL/i);
    }
    expect(gateway).toMatch(/identity-source-record-key:v2/);
    expect(gateway).toMatch(/IDENTITY_SOURCE_KEY_SECRET/);
    expect(gateway).toMatch(/IDENTITY_SOURCE_KEY_ID/);
    expect(gateway).toMatch(/identity_source_key_configuration_mismatch/);
    expect(gateway).not.toMatch(/const secret = env\?\.IDENTITY_VERIFICATION_SECRET/);
    expect(gateway).toMatch(/crypto\.subtle\.importKey\([\s\S]*?name: 'HMAC'/);
    expect(gateway).toMatch(/crypto\.subtle\.sign\('HMAC'/);
    expect(gateway).not.toMatch(/crypto\.subtle\.digest\('SHA-256'/);
  });

  it('keeps SQL identifiers static rather than interpolating a source policy into SQL', () => {
    expect(gateway).not.toMatch(/prepare\s*\(\s*`[^`]*\$\{\s*input\.(?:source|attachmentPolicy)/s);
    expect(gateway).not.toMatch(/(?:FROM|JOIN|INTO|UPDATE)\s+\$\{/);
  });

  it('documents and provisions a separately stable source key with an explicit pinned key id', () => {
    expect(devVars).toMatch(/^IDENTITY_SOURCE_KEY_SECRET=/m);
    expect(devVars).toMatch(/^IDENTITY_SOURCE_KEY_ID=v1$/m);
    expect(wranglerTemplate).toMatch(/"IDENTITY_SOURCE_KEY_ID": "v1"/);
    expect(wranglerTemplate).not.toMatch(/"IDENTITY_SOURCE_KEY_SECRET"\s*:/);
    expect(setupSecrets).toMatch(/IDENTITY_SOURCE_KEY_SECRET[\s\S]*?randomBytes\(32\)/);
    expect(deployDocs).toMatch(/Do not rotate either value in place/i);
    expect(deployDocs).toMatch(/transactional rewrap migration/i);
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/source_key_id TEXT NOT NULL REFERENCES identity_source_key_config\(key_id\)/i);
      expect(sql).toMatch(/algorithm_version[^\n]*CHECK \(algorithm_version=1\)/i);
    }
  });
});
