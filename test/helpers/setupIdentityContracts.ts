import { expect, it } from 'vitest';
import type { AppDb, AppStatement } from '../../src/lib/appDb';
import { bootstrapFirstAdmin, isBootstrapAdminReady } from '../../src/lib/setupDb.mjs';
import { revokeVerifiedContactOwner } from '../../src/lib/identityDb';

export function setupIdentityContracts(getDb: () => AppDb) {
  const input = (label: string) => ({ email: `${label}-${crypto.randomUUID()}@setup.test`, displayName: 'Setup administrator', locale: 'en' as const });

  it('rolls back the entire new administrator when identity audit persistence fails, then safely retries', async () => {
    const db = getDb(); const admin = input('rollback');
    const failingDb = {
      prepare: db.prepare.bind(db),
      batch: (statements: AppStatement[]) => db.batch([...statements, db.prepare("INSERT INTO identity_audit_events(event_type) VALUES(NULL)")]),
    } as AppDb;
    await expect(bootstrapFirstAdmin(failingDb, admin)).rejects.toThrow();
    expect(await db.prepare('SELECT id FROM people WHERE email=?').bind(admin.email).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?").bind(admin.email).first()).toBeNull();
    expect(await bootstrapFirstAdmin(db, admin)).toMatchObject({ status: 'created' });
    expect(await isBootstrapAdminReady(db, admin.email)).toBe(true);
  });

  it('does not turn an existing administrator email into identity proof', async () => {
    const db = getDb(); const admin = input('unverified');
    await db.prepare("INSERT INTO people(display_name,email,role,super_admin) VALUES(?1,?2,'admin',1)").bind(admin.displayName, admin.email).run();
    expect(await bootstrapFirstAdmin(db, admin)).toMatchObject({ status: 'already-admin' });
    expect(await isBootstrapAdminReady(db, admin.email)).toBe(false);
    expect(await db.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?").bind(admin.email).first()).toBeNull();
  });

  it('preserves a revoked bootstrap identity on rerun', async () => {
    const db = getDb(); const admin = input('revoked');
    await bootstrapFirstAdmin(db, admin);
    const owner = await db.prepare(`SELECT o.person_id,c.id FROM contact_points c JOIN verified_contact_owners o ON o.contact_point_id=c.id
      WHERE c.kind='email' AND c.normalized_value=?`).bind(admin.email).first<{ person_id: number; id: number }>();
    expect(owner).not.toBeNull();
    await revokeVerifiedContactOwner(db, { campusId: 1, contactPointId: owner!.id,
      proof: { kind: 'admin', actorPersonId: owner!.person_id, reasonCode: 'admin_review' } });
    const before = await db.prepare('SELECT count(*) n FROM contact_owner_mutation_claims WHERE contact_point_id=?').bind(owner!.id).first<number>('n');
    expect(await bootstrapFirstAdmin(db, admin)).toMatchObject({ status: 'already-admin' });
    expect(await isBootstrapAdminReady(db, admin.email)).toBe(false);
    expect(await db.prepare('SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?').bind(owner!.id).first()).toBeNull();
    expect(await db.prepare('SELECT count(*) n FROM contact_owner_mutation_claims WHERE contact_point_id=?').bind(owner!.id).first<number>('n')).toBe(before);
  });

  it('cannot claim a contact owned by another identity while creating an administrator', async () => {
    const db = getDb(); const owner = input('existing-owner');
    await bootstrapFirstAdmin(db, owner);
    const ownerId = await db.prepare('SELECT id FROM people WHERE email=?').bind(owner.email).first<number>('id');
    await db.prepare('UPDATE people SET email=? WHERE id=?').bind(`other-${owner.email}`, ownerId).run();
    await expect(bootstrapFirstAdmin(db, owner)).rejects.toThrow();
    expect(await db.prepare('SELECT id FROM people WHERE email=?').bind(owner.email).first()).toBeNull();
    expect(await db.prepare(`SELECT o.person_id FROM verified_contact_owners o JOIN contact_points c ON c.id=o.contact_point_id
      WHERE c.kind='email' AND c.normalized_value=?`).bind(owner.email).first<number>('person_id')).toBe(ownerId);
  });

  it('creates only one audited identity when two setup attempts race', async () => {
    const db = getDb(); const admin = input('concurrent');
    const results = await Promise.all([bootstrapFirstAdmin(db, admin), bootstrapFirstAdmin(db, admin)]);
    expect(results.map((result) => result.status).sort()).toEqual(['already-admin', 'created']);
    expect(await isBootstrapAdminReady(db, admin.email)).toBe(true);
    expect(await db.prepare(`SELECT count(*) n FROM identity_audit_events a JOIN people p ON p.id=a.subject_person_id
      WHERE p.email=? AND a.event_type='setup_admin_bootstrapped'`).bind(admin.email).first<number>('n')).toBe(1);
  });
}
