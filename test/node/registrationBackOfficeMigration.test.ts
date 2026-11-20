import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The payment-method backfill of 0053: a registration that went through Stripe Checkout was paid by card.
const sql = readFileSync('migrations/0053_registration_back_office.sql', 'utf8');
const start = sql.indexOf('UPDATE registrations SET payment_method');
const statement = sql.slice(start, sql.indexOf(';', start) + 1);

describe('0053 payment-method backfill on D1', () => {
  it('marks registrations with a Checkout session as stripe and leaves the rest NULL', () => {
    expect(statement).toContain("'stripe'");
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE registrations (id INTEGER PRIMARY KEY, stripe_checkout_session_id TEXT, payment_method TEXT);
      INSERT INTO registrations (id, stripe_checkout_session_id) VALUES (1, 'cs_test_1'), (2, NULL), (3, 'cs_test_3');
    `);
    db.exec(statement);
    const rows = db.prepare('SELECT id, payment_method FROM registrations ORDER BY id').all() as Array<{ id: number; payment_method: string | null }>;
    expect(rows.map((r) => [r.id, r.payment_method])).toEqual([[1, 'stripe'], [2, null], [3, 'stripe']]);
  });
});
