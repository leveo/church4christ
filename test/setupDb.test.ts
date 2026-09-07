import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, AppStatement } from '../src/lib/appDb';
import { MODULE_KEYS } from '../src/lib/modules';
import { bootstrapFirstAdmin, initializeModuleSettings } from '../src/lib/setupDb.mjs';
import { beginSignin, completeSigninLink } from '../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'module.%'").run();
  // Each case uses a distinct identity; append-only ownership audits must not
  // be deleted to clean up a previous case.
});

describe('setup database operations on D1', () => {
  it('writes every module setting explicitly and atomically in one statement', async () => {
    const prepare = vi.fn(env.DB.prepare.bind(env.DB));
    const db = { prepare, batch: env.DB.batch.bind(env.DB) } as AppDb;

    await initializeModuleSettings(db, MODULE_KEYS, ['sermons', 'people']);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain('ON CONFLICT(key) DO UPDATE');
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'module.%' ORDER BY key",
    ).all<{ key: string; value: string }>();
    expect(results).toHaveLength(MODULE_KEYS.length);
    expect(Object.fromEntries(results.map((row) => [row.key, row.value]))).toMatchObject({
      'module.sermons': '1',
      'module.people': '1',
      'module.portal': '0',
    });
  });

  it('rejects duplicate or unknown module keys before preparing SQL', async () => {
    const prepare = vi.fn(() => { throw new Error('must not query'); });
    const db = { prepare, batch: vi.fn() } as unknown as AppDb;

    await expect(initializeModuleSettings(db, ['sermons', 'sermons'], ['sermons']))
      .rejects.toThrow(/duplicate.*module key/i);
    await expect(initializeModuleSettings(db, MODULE_KEYS, ['sermons', 'sermons']))
      .rejects.toThrow(/duplicate.*selected module/i);
    await expect(initializeModuleSettings(db, MODULE_KEYS, ['not-real' as never]))
      .rejects.toThrow(/unknown selected module/i);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('creates and reruns the same administrator idempotently', async () => {
    const input = { email: ' Admin@Setup.Test ', displayName: '  Setup Admin  ', locale: 'en' as const };
    expect(await bootstrapFirstAdmin(env.DB, input)).toEqual({ status: 'created', email: 'admin@setup.test' });
    expect(await bootstrapFirstAdmin(env.DB, input)).toEqual({ status: 'already-admin', email: 'admin@setup.test' });
    const row = await env.DB.prepare('SELECT display_name, lang, super_admin FROM people WHERE email=?')
      .bind('admin@setup.test').first<{ display_name: string; lang: string; super_admin: number }>();
    expect(row).toEqual({ display_name: 'Setup Admin', lang: 'en', super_admin: 1 });
    const authEnv = { IDENTITY_VERIFICATION_SECRET: 'setup-signin-regression-secret-at-least-thirty-two-characters' };
    const begun = await beginSignin(env.DB, authEnv, {
      campusId: 1, email: 'admin@setup.test', now: '2035-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.43' }), 'setup-no-demo'),
    });
    expect(begun.delivery).not.toBeNull();
    const result = await completeSigninLink(env.DB, authEnv, {
      campusId: 1, publicId: begun.delivery!.publicId, token: begun.delivery!.token, now: '2035-01-01 00:01:00',
    });
    expect(result).toMatchObject({ status: 'authenticated', sessionEpoch: 0 });
    expect((await env.DB.prepare('SELECT email FROM people WHERE id=?').bind((result as { personId: number }).personId).first())?.email).toBe('admin@setup.test');
  });

  it('requires explicit promotion and refuses inactive or deleted people', async () => {
    await env.DB.prepare(
      "INSERT INTO people (display_name,email,role,active) VALUES ('Member','member@setup.test','member',1),('Inactive','inactive@setup.test','member',0),('Deleted','deleted@setup.test','member',1)",
    ).run();
    await env.DB.prepare("UPDATE people SET deleted_at=datetime('now') WHERE email='deleted@setup.test'").run();

    await expect(bootstrapFirstAdmin(env.DB, { email: 'member@setup.test', displayName: 'Member', locale: 'en' }))
      .resolves.toEqual({ status: 'promotion-required', email: 'member@setup.test' });
    await expect(bootstrapFirstAdmin(env.DB, { email: 'member@setup.test', displayName: 'Member', locale: 'en', promoteExisting: true }))
      .resolves.toEqual({ status: 'promoted', email: 'member@setup.test' });
    expect(await env.DB.prepare('SELECT role, super_admin FROM people WHERE email=?').bind('member@setup.test').first())
      .toEqual({ role: 'admin', super_admin: 1 });
    await expect(bootstrapFirstAdmin(env.DB, { email: 'inactive@setup.test', displayName: 'Inactive', locale: 'en' }))
      .resolves.toEqual({ status: 'inactive', email: 'inactive@setup.test' });
    await expect(bootstrapFirstAdmin(env.DB, { email: 'deleted@setup.test', displayName: 'Deleted', locale: 'en' }))
      .resolves.toEqual({ status: 'reactivation-required', email: 'deleted@setup.test' });
  });

  it('requires explicit consent to elevate an existing limited admin', async () => {
    await env.DB.prepare(
      "INSERT INTO people (display_name,email,role,active,super_admin,admin_areas) VALUES ('Limited','limited@setup.test','admin',1,0,'events')",
    ).run();
    await expect(bootstrapFirstAdmin(env.DB, {
      email: 'limited@setup.test', displayName: 'Limited', locale: 'en',
    })).resolves.toEqual({ status: 'promotion-required', email: 'limited@setup.test' });
    await expect(bootstrapFirstAdmin(env.DB, {
      email: 'limited@setup.test', displayName: 'Limited', locale: 'en', promoteExisting: true,
    })).resolves.toEqual({ status: 'promoted', email: 'limited@setup.test' });
    expect(await env.DB.prepare('SELECT role, super_admin, admin_areas FROM people WHERE email=?')
      .bind('limited@setup.test').first()).toEqual({ role: 'admin', super_admin: 1, admin_areas: 'events' });
  });

  it('rejects malformed inputs before querying', async () => {
    const prepare = vi.fn(() => { throw new Error('must not query'); });
    const db = { prepare, batch: vi.fn() } as unknown as AppDb;
    const invalidEmails = ['bad', '.lead@setup.test', 'two..dots@setup.test', 'a@-setup.test'];

    for (const email of invalidEmails) {
      await expect(bootstrapFirstAdmin(db, { email, displayName: 'Admin', locale: 'en' }))
        .rejects.toThrow(/email/i);
    }
    await expect(bootstrapFirstAdmin(db, { email: 'a@setup.test', displayName: ' ', locale: 'en' }))
      .rejects.toThrow(/display name/i);
    await expect(bootstrapFirstAdmin(db, { email: 'a@setup.test', displayName: 'Admin', locale: 'fr' as never }))
      .rejects.toThrow(/locale/i);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('recovers only recognized unique races and preserves the raced account state', async () => {
    const admin = { id: 99, role: 'admin', active: 1, deleted_at: null, super_admin: 1 };
    let finds = 0;
    const unique = new Error('D1_ERROR: UNIQUE constraint failed: people.email: SQLITE_CONSTRAINT');
    const statement = (kind: 'find' | 'insert'): AppStatement => ({
      bind: () => statement(kind),
      first: async <T>() => (kind === 'find' && ++finds > 1 ? admin : null) as T | null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => { throw unique; },
    });
    const db = {
      prepare: (sql: string) => statement(sql.startsWith('SELECT') ? 'find' : 'insert'),
      batch: async (statements: AppStatement[]) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as AppDb;

    await expect(bootstrapFirstAdmin(db, { email: 'race@setup.test', displayName: 'Race', locale: 'en' }))
      .resolves.toEqual({ status: 'already-admin', email: 'race@setup.test' });

    const unrelated = new Error('database unavailable');
    const failingStatement = (kind: 'find' | 'insert'): AppStatement => ({
      bind: () => failingStatement(kind),
      first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => { throw unrelated; },
    });
    const failingDb = {
      prepare: (sql: string) => failingStatement(sql.startsWith('SELECT') ? 'find' : 'insert'),
      batch: async (statements: AppStatement[]) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as AppDb;
    await expect(bootstrapFirstAdmin(failingDb, { email: 'error@setup.test', displayName: 'Error', locale: 'en' }))
      .rejects.toBe(unrelated);
  });

  it('binds the normalized email into promotion so changed identity ownership cannot grant admin', async () => {
    const targetEmail = 'owner@setup.test';
    const person = { id: 77, email: targetEmail, role: 'member', active: 1, deleted_at: null as string | null, super_admin: 0 };
    let updateSql = '';
    let updateBinds: unknown[] = [];
    const db = {
      prepare: (sql: string) => {
        let binds: unknown[] = [];
        const statement: AppStatement = {
          bind: (...values: unknown[]) => {
            binds = values;
            return statement;
          },
          first: async <T>() => (
            sql.startsWith('SELECT') && person.email.toLowerCase() === targetEmail ? person : null
          ) as T | null,
          all: async () => ({ results: [], meta: { changes: 0 } }),
          run: async () => {
            if (!sql.startsWith('UPDATE')) return { results: [], meta: { changes: 0 } };
            updateSql = sql;
            updateBinds = binds;
            // The originally found person loses this email immediately before
            // the conditional UPDATE executes.
            person.email = 'moved@setup.test';
            const guardsEmail = sql.includes('lower(email)=?');
            const matchesEmail = guardsEmail && binds[1] === targetEmail && person.email.toLowerCase() === binds[1];
            if (!guardsEmail || matchesEmail) { person.role = 'admin'; person.super_admin = 1; }
            return { results: [], meta: { changes: person.role === 'admin' ? 1 : 0 } };
          },
        };
        return statement;
      },
      batch: async (statements: AppStatement[]) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as AppDb;

    await expect(bootstrapFirstAdmin(db, {
      email: ' Owner@Setup.Test ',
      displayName: 'Owner',
      locale: 'en',
      promoteExisting: true,
    })).rejects.toThrow(/concurrent update/i);
    expect(updateSql).toContain('lower(email)=?');
    expect(updateBinds).toEqual([77, targetEmail]);
    expect(person.role).toBe('member');
  });

  it('rethrows SQLite unique errors unrelated to the people email constraint', async () => {
    const unrelatedUnique = new Error('D1_ERROR: UNIQUE constraint failed: settings.key: SQLITE_CONSTRAINT');
    const statement = (kind: 'find' | 'insert'): AppStatement => ({
      bind: () => statement(kind),
      first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => { throw unrelatedUnique; },
    });
    const db = {
      prepare: (sql: string) => statement(sql.startsWith('SELECT') ? 'find' : 'insert'),
      batch: async (statements: AppStatement[]) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as AppDb;

    await expect(bootstrapFirstAdmin(db, {
      email: 'unique@setup.test',
      displayName: 'Unique',
      locale: 'en',
    })).rejects.toBe(unrelatedUnique);
  });

  it('never promotes an active member discovered after a unique insert race', async () => {
    const unique = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const member = { id: 100, role: 'member', active: 1, deleted_at: null, super_admin: 0 };
    let finds = 0;
    const prepared: string[] = [];
    const statement = (kind: 'find' | 'insert' | 'update'): AppStatement => ({
      bind: () => statement(kind),
      first: async <T>() => (kind === 'find' && ++finds > 1 ? member : null) as T | null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => {
        if (kind === 'insert') throw unique;
        throw new Error('race classification must not update');
      },
    });
    const db = {
      prepare: (sql: string) => {
        prepared.push(sql);
        return statement(sql.startsWith('SELECT') ? 'find' : sql.startsWith('INSERT') ? 'insert' : 'update');
      },
      batch: async (statements: AppStatement[]) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as AppDb;

    await expect(bootstrapFirstAdmin(db, {
      email: 'race-member@setup.test',
      displayName: 'Race Member',
      locale: 'en',
      promoteExisting: true,
    })).resolves.toEqual({ status: 'promotion-required', email: 'race-member@setup.test' });
    expect(prepared.some((sql) => sql.startsWith('UPDATE'))).toBe(false);
  });

  it('reports inactive when a unique-race row is absent on the post-read', async () => {
    const unique = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const statement = (kind: 'find' | 'insert'): AppStatement => ({
      bind: () => statement(kind),
      first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => { throw unique; },
    });
    const db = {
      prepare: (sql: string) => statement(sql.startsWith('SELECT') ? 'find' : 'insert'),
      batch: async (statements: AppStatement[]) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    } as AppDb;

    await expect(bootstrapFirstAdmin(db, {
      email: 'race-gone@setup.test',
      displayName: 'Race Gone',
      locale: 'en',
      promoteExisting: true,
    })).resolves.toEqual({ status: 'inactive', email: 'race-gone@setup.test' });
  });
});
