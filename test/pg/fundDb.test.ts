// fundDb (Supabase-only giving module) against real Postgres. Migrates + seeds a
// fresh database the operator's way (the runner pattern), builds a PgAdapter over
// it, and exercises fund create/update/list/toggle + the localized i18n fallback
// and the duplicate fund_number → 'fund_number_taken' guard. Self-skips when
// DATABASE_URL is unset, like every test/pg suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { listFunds, getFund, saveFund, toggleFundActive } from '../../src/lib/fundDb';

describe.skipIf(!hasPg)('fundDb (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('saveFund inserts a fund + BOTH locale names and returns its id', async () => {
    const id = await saveFund(db, {
      fund_number: 'F100',
      name_en: 'General Fund',
      name_zh: '总奉献',
      active: 1,
      sort: 1,
    });
    expect(typeof id).toBe('number');

    const en = await getFund(db, 'en', id);
    expect(en).toMatchObject({ id, fund_number: 'F100', name: 'General Fund', active: 1, sort: 1 });
    const zh = await getFund(db, 'zh', id);
    expect(zh?.name).toBe('总奉献');
  });

  it('getFund falls back to en when the locale row is missing', async () => {
    // Write only via saveFund (always writes both), then delete the zh row to
    // prove the en-fallback join, not a stored zh value.
    const id = await saveFund(db, { fund_number: 'F101', name_en: 'Missions', name_zh: '宣教', active: 1, sort: 2 });
    await sql.unsafe('DELETE FROM fund_i18n WHERE fund_id = $1 AND locale = $2', [id, 'zh']);
    const zh = await getFund(db, 'zh', id);
    expect(zh?.name).toBe('Missions'); // en fallback
  });

  it('getFund returns null for an unknown id', async () => {
    expect(await getFund(db, 'en', 999999)).toBeNull();
  });

  it('saveFund with an id updates the fund and both names', async () => {
    const id = await saveFund(db, { fund_number: 'F102', name_en: 'Building', name_zh: '建堂', active: 1, sort: 3 });
    const same = await saveFund(db, { id, fund_number: 'F102', name_en: 'Building Fund', name_zh: '建堂基金', active: 1, sort: 5 });
    expect(same).toBe(id);
    const en = await getFund(db, 'en', id);
    expect(en).toMatchObject({ name: 'Building Fund', sort: 5 });
    expect((await getFund(db, 'zh', id))?.name).toBe('建堂基金');
  });

  it('saveFund throws fund_number_taken on a duplicate fund_number (insert)', async () => {
    await saveFund(db, { fund_number: 'F103', name_en: 'Benevolence', name_zh: '慈惠', active: 1, sort: 4 });
    await expect(
      saveFund(db, { fund_number: 'F103', name_en: 'Dup', name_zh: '重复', active: 1, sort: 9 }),
    ).rejects.toThrow('fund_number_taken');
  });

  it('saveFund throws fund_number_taken when an update collides with another number', async () => {
    const a = await saveFund(db, { fund_number: 'F104', name_en: 'A', name_zh: '甲', active: 1, sort: 6 });
    await saveFund(db, { fund_number: 'F105', name_en: 'B', name_zh: '乙', active: 1, sort: 7 });
    await expect(
      saveFund(db, { id: a, fund_number: 'F105', name_en: 'A', name_zh: '甲', active: 1, sort: 6 }),
    ).rejects.toThrow('fund_number_taken');
  });

  it('listFunds is locale-aware, sorted, and honors activeOnly', async () => {
    const inactiveId = await saveFund(db, { fund_number: 'F900', name_en: 'Archived', name_zh: '已归档', active: 0, sort: 99 });

    const en = await listFunds(db, 'en');
    const enById = Object.fromEntries(en.map((f) => [f.id, f]));
    expect(enById[inactiveId].name).toBe('Archived');
    // sorted by sort then id
    const sorts = en.map((f) => f.sort);
    expect([...sorts]).toEqual([...sorts].sort((a, b) => a - b));

    const zh = await listFunds(db, 'zh');
    expect(Object.fromEntries(zh.map((f) => [f.id, f.name]))[inactiveId]).toBe('已归档');

    const activeOnly = await listFunds(db, 'en', { activeOnly: true });
    expect(activeOnly.some((f) => f.id === inactiveId)).toBe(false);
    expect(activeOnly.every((f) => f.active === 1)).toBe(true);
  });

  it('toggleFundActive flips the active flag', async () => {
    const id = await saveFund(db, { fund_number: 'F200', name_en: 'Toggle', name_zh: '切换', active: 1, sort: 8 });
    await toggleFundActive(db, id);
    expect((await getFund(db, 'en', id))?.active).toBe(0);
    await toggleFundActive(db, id);
    expect((await getFund(db, 'en', id))?.active).toBe(1);
  });
});
