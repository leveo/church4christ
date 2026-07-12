// Member-portal seed coverage against a fresh Postgres schema. The portal-only
// tables deliberately have no D1 migration, so this test exercises the real
// db:seed:supabase path rather than the portable dev-seed D1 harness.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('member portal demo seed (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    const run = (script: string) =>
      execFileSync('node', [`scripts/db/${script}`], {
        env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
        encoding: 'utf8',
      });
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('seeds a group-file record, event administrators, and moderated prayer scopes', async () => {
    const [file] = await sql.unsafe<{
      group_id: number;
      uploaded_by: number;
      file_name: string;
      r2_key: string;
      content_type: string;
    }[]>('SELECT group_id, uploaded_by, file_name, r2_key, content_type FROM group_files');
    expect(file).toMatchObject({
      group_id: 1,
      uploaded_by: 8,
      file_name: 'young-adults-welcome.pdf',
      r2_key: 'group-files/1/demo-young-adults-welcome.pdf',
      content_type: 'application/pdf',
    });

    const eventAdmins = await sql.unsafe<{ reg_event_id: number; person_id: number }[]>(
      'SELECT reg_event_id, person_id FROM event_admins ORDER BY reg_event_id, person_id',
    );
    expect(eventAdmins).toEqual([
      { reg_event_id: 900, person_id: 2 },
      { reg_event_id: 910, person_id: 7 },
    ]);

    const scopes = await sql.unsafe<{ scope: string; status: string }[]>(
      'SELECT scope, status FROM prayer_items WHERE deleted_at IS NULL ORDER BY id',
    );
    expect(scopes).toEqual([
      { scope: 'church', status: 'approved' },
      { scope: 'group', status: 'pending' },
      { scope: 'event', status: 'pending' },
      { scope: 'private', status: 'approved' },
    ]);
  });
});
