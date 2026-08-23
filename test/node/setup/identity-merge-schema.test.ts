import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1 = readFileSync('migrations/0033_identity_merge_operations.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0033_identity_merge_operations.sql', 'utf8');

describe('identity merge operation migration contract', () => {
  it('keeps the D1 and PostgreSQL table and enum vocabulary paired', () => {
    for (const table of [
      'person_merge_operations', 'person_merge_approvals', 'person_merge_conflict_decisions',
      'person_merge_risk_facts', 'person_merge_risk_set_facts', 'person_merge_risk_set_seals', 'person_merge_registry_keys',
      'person_merge_mutation_receipts', 'person_merge_reassignment_journal', 'person_merge_rollback_receipts',
    ]) {
      expect(d1).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
      expect(pg).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
    }
    for (const token of [
      'subject_repoint', 'dedupe_then_repoint', 'operational_actor_repoint',
      'historical_preserve', 'security_revoke', 'hard_conflict',
      'canonical_only', 'manual_required', 'revoke_loser',
    ]) {
      expect(d1).toContain(`'${token}'`);
      expect(pg).toContain(`'${token}'`);
    }
  });

  it('serializes opposite PostgreSQL pairs with ordered advisory locks', () => {
    expect(pg).toMatch(/pg_advisory_xact_lock\s*\(\s*least\s*\(\s*NEW\.loser_person_id\s*,\s*NEW\.canonical_person_id\s*\)\s*\)/i);
    expect(pg).toMatch(/pg_advisory_xact_lock\s*\(\s*greatest\s*\(\s*NEW\.loser_person_id\s*,\s*NEW\.canonical_person_id\s*\)\s*\)/i);
    expect(pg).toContain('person_merge_active_pair');
    expect(pg).toContain('person_merge_redirect_chain_guard');
    expect(pg).toMatch(/person_merge_operations_case_guard_fn[\s\S]*?identity_resolution_cases[\s\S]*?FOR UPDATE/i);
    expect(pg).toMatch(/person_merge_operations_case_stale_guard_fn[\s\S]*?identity_resolution_cases[\s\S]*?FOR UPDATE/i);
  });

  it('forces every PostgreSQL live-risk writer into the same ordered person lock protocol', () => {
    expect(pg).toContain('person_merge_risk_source_writer_lock_fn');
    expect(pg).toContain('person_merge_operations_risk_source_guard_fn');
    expect(pg.match(/pg_advisory_xact_lock/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    for (const table of [
      'people', 'verified_contact_owners', 'household_members', 'recurring_gifts',
      'person_external_identities', 'learning_identity_links', 'tokens', 'identity_challenges',
      'group_attendance_tokens', 'learning_google_oauth_states', 'learning_canvas_oauth_states',
      'identity_recovery_holds', 'identity_recovery_cases', 'campus_memberships',
      'person_contact_links', 'group_members', 'team_members', 'roster_assignments',
      'person_interests', 'identity_source_records', 'identity_person_canonical_keys', 'event_admins',
    ]) {
      expect(pg).toMatch(new RegExp(`CREATE TRIGGER person_merge_risk_writer_${table}\\b[\\s\\S]*? ON ${table}\\b`));
    }
    expect(d1).toContain('D1 serializes writers; the transition trigger revalidates live risk in the same write transaction.');
  });

  it('serializes approval and decision inserts with operation and person advisory locks before checking staleness', () => {
    for (const guard of ['person_merge_approvals_stale_guard_fn', 'person_merge_conflict_decisions_stale_guard_fn']) {
      const start = pg.indexOf(`CREATE FUNCTION ${guard}`);
      const end = pg.indexOf('CREATE TRIGGER', start);
      const body = pg.slice(start, end);
      expect(start, guard).toBeGreaterThanOrEqual(0);
      expect(body, guard).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*NEW\.operation_id\s*\)\s*\)/i);
      expect(body, guard).toContain('person_merge_lock_operation_people_fn');
      expect(body, guard).toMatch(/IF NOT EXISTS\s*\(\s*SELECT 1 FROM person_merge_operations/i);
    }
    expect(d1).toContain('D1 serializes approval and decision inserts with operation transitions');
  });

  it('uses one global PostgreSQL person lock order without tuple locks after advisory serialization', () => {
    const lockStart = pg.indexOf('CREATE FUNCTION person_merge_lock_operation_people_fn');
    const lockEnd = pg.indexOf('CREATE FUNCTION', lockStart + 16);
    const lockBody = pg.slice(lockStart, lockEnd);
    expect(lockStart).toBeGreaterThanOrEqual(0);
    expect(lockBody).toContain('person_merge_approvals');
    expect(lockBody).toContain('extra_person_id');
    expect(lockBody).toMatch(/ORDER BY\s+person_id[\s\S]*pg_advisory_xact_lock\s*\(\s*lock_person_id\s*\)/i);
    for (const guard of [
      'person_merge_operations_a_global_lock_guard_fn',
      'person_merge_approvals_master_admin_guard_fn',
      'person_merge_approvals_stale_guard_fn',
      'person_merge_conflict_decisions_stale_guard_fn',
    ]) {
      const start = pg.indexOf(`CREATE FUNCTION ${guard}`);
      const end = pg.indexOf('CREATE TRIGGER', start);
      expect(pg.slice(start, end), guard).toContain('person_merge_lock_operation_people_fn');
    }
    const eligibilityStart = pg.indexOf('CREATE FUNCTION person_merge_operations_approval_eligibility_guard_fn');
    const eligibilityEnd = pg.indexOf('CREATE TRIGGER', eligibilityStart);
    expect(pg.slice(eligibilityStart, eligibilityEnd)).not.toMatch(/FOR UPDATE OF (p|cm)/i);
  });

  it('binds every journal row to exact execution mutation evidence and exact full rollback counts', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toContain('person_merge_mutation_receipts_binding_guard');
      expect(sql).toContain('mutation_receipt_id');
      expect(sql).toContain('row_key_hash');
      expect(sql).toMatch(/NEW\.reverted_count\s*=\s*journal\.affected_count/);
      expect(sql).toMatch(/NEW\.outcome='failed'\s+AND\s+NEW\.reverted_count=0/);
    }
  });

  it('has no unbounded JSON, payload, notes, answers, contact values, or gift amount carriers', () => {
    for (const sql of [d1, pg]) {
      const createTables = [...sql.matchAll(/CREATE TABLE person_merge_[\s\S]*?\n\);/g)].map(([value]) => value).join('\n');
      expect(createTables).not.toMatch(/\bJSONB?\b|_json\b|payload|note_body|answer|contact_value|gift_amount/i);
    }
  });

  it('keeps directional facts and every hardening guard paired across backends', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/loser_count INTEGER NOT NULL/);
      expect(sql).toMatch(/canonical_count INTEGER NOT NULL/);
      expect(sql).toContain('presence_count=loser_count+canonical_count');
      expect(sql).toContain('person_merge_operations_decision_gate_guard');
      expect(sql).toContain('person_merge_registry_keys_append_only_insert');
      expect(sql).toContain('person_merge_rollback_receipts_count_guard');
      expect(sql).toContain("p.calendar_token IS NOT NULL AND p.calendar_token<>''");
      expect(sql).toContain('identity_recovery_holds h JOIN identity_recovery_cases c');
      expect(sql).toContain("p.role='admin' AND p.super_admin=1");
      expect(sql).toContain("p.identity_state='active' AND p.auth_disabled_at IS NULL");
      expect(sql).toContain('step_up_challenge_id');
      expect(sql).toContain('person_merge_approvals_step_up_guard');
      expect(sql).toContain('person_merge_redirects_append_only_update');
      expect(sql).toContain('person_merge_redirects_append_only_delete');
      expect(sql).toContain("cm.role='admin'");
    }
  });

  it('binds semantic identifiers by non-secret monotonic generations', () => {
    for (const sql of [d1, pg]) {
      for (const column of [
        'merge_stripe_customer_binding_version', 'merge_calendar_binding_version', 'merge_binding_version',
      ]) expect(sql).toContain(column);
      for (const trigger of [
        'person_merge_semantic_binding_people_guard',
        'person_merge_semantic_binding_people_stripe_bump',
        'person_merge_semantic_binding_people_calendar_bump',
        'person_merge_semantic_binding_external_identity_guard',
        'person_merge_semantic_binding_external_identity_bump',
        'person_merge_semantic_binding_learning_identity_guard',
        'person_merge_semantic_binding_learning_identity_bump',
        'person_merge_semantic_binding_canonical_key_guard',
        'person_merge_semantic_binding_canonical_key_bump',
      ]) expect(sql).toContain(trigger);
      expect(sql).toContain('person_merge_semantic_binding_version_invalid');
      expect(sql).toContain('binding-version:');
      expect(sql).not.toMatch(/['"](?:calendar:)?present['"]/i);
      expect(sql).not.toMatch(/\|\|\s*(?:p\.stripe_customer_id|p\.calendar_token|x\.provider|x\.organization_id|x\.external_person_id|x\.external_user_id|x\.stripe_subscription_id)/i);
    }
    expect(pg).toContain('person_merge_semantic_binding_recurring_gift_guard');
    expect(pg).toContain('person_merge_semantic_binding_recurring_gift_bump');
  });
});
