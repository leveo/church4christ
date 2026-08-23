import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1 = readFileSync('migrations/0035_identity_business_continuations.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0035_identity_business_continuations.sql', 'utf8');

describe('identity business continuation schema contract', () => {
  it('ships paired giving and registration continuation tables with bounded payloads', () => {
    for (const sql of [d1, pg]) {
      expect(sql).toMatch(/CREATE TABLE identity_giving_checkout_continuations/i);
      expect(sql).toMatch(/CREATE TABLE identity_registration_continuations/i);
      expect(sql).toMatch(/identity_business_intent_receipt_guard/i);
      expect(sql).toMatch(/giving_checkout/i);
      expect(sql).toMatch(/registration/i);
      expect(sql).toMatch(/checkout_request_id/i);
      expect(sql).toMatch(/source_record_id/i);
      expect(sql).toMatch(/append_only/i);
      expect(sql).toMatch(/ADD COLUMN signup_delivery_ciphertext TEXT/i);
      expect(sql).toMatch(/ADD COLUMN signup_delivery_count INTEGER NOT NULL DEFAULT 0/i);
      expect(sql).toMatch(/ADD COLUMN signup_delivery_not_before TEXT/i);
      expect(sql).toMatch(/question_digest TEXT NOT NULL/i);
      expect(sql).toMatch(/identity_business_delivery_lifecycle_guard/i);
      expect(sql).toMatch(/signup_delivery_ciphertext\s+IS\s+NULL/i);
      expect(sql).not.toMatch(/signup_delivery_(?:code|email)\s+TEXT/i);
    }
    expect(d1).toMatch(/amount_cents INTEGER NOT NULL CHECK \(amount_cents > 0\)/i);
    expect(pg).toMatch(/amount_cents INTEGER NOT NULL CHECK \(amount_cents > 0\)/i);
  });

  it('terminates every PostgreSQL PL/pgSQL function body with END semicolon', () => {
    expect(pg).not.toMatch(/\bEND\s+\$\$;/u);
    expect(pg.match(/\bEND;\s*\$\$;/gu)?.length).toBe(10);
  });

  it('keeps PostgreSQL delivery insert and update guards as separate single-effect functions', () => {
    const insert = pg.match(/CREATE OR REPLACE FUNCTION identity_business_delivery_insert_guard\(\)[\s\S]*?END;\s*\$\$;/u)?.[0];
    const lifecycle = pg.match(/CREATE OR REPLACE FUNCTION identity_business_delivery_lifecycle_guard\(\)[\s\S]*?END;\s*\$\$;/u)?.[0];
    expect(insert).toBeDefined();
    expect(lifecycle).toBeDefined();
    expect(insert).not.toMatch(/\b(?:ELSIF|ELSE|TG_OP)\b/u);
    expect(lifecycle).not.toMatch(/\b(?:ELSIF|ELSE|TG_OP)\b/u);
    expect(insert?.match(/RAISE EXCEPTION/gu)).toHaveLength(1);
    expect(lifecycle?.match(/RAISE EXCEPTION/gu)).toHaveLength(1);
  });
});
