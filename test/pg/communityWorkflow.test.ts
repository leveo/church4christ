import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { scopeDatabase } from '../../src/lib/campusScope';
import {
  createFellowship,
  assignFellowshipGroup,
  saveFellowshipMember,
} from '../../src/lib/fellowshipDb';
import {
  createWorkflowTemplate,
  startWorkflow,
  listWorkflowTasks,
  updateWorkflowTask,
} from '../../src/lib/workflowDb';
import type { AppDb } from '../../src/lib/appDb';
describe.skipIf(!hasPg)('community workflow PostgreSQL parity', () => {
  const sql = hasPg ? pgClient() : null;
  let db: AppDb;
  beforeAll(async () => {
    await resetSchema(sql!);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      stdio: 'pipe',
    });
    db = scopeDatabase(new PgAdapter(sql!), 1);
    await db
      .prepare(
        "INSERT INTO people(id,display_name,email) VALUES(99001,'Coordinator','coordinator@example.test'),(99002,'Member','member@example.test')",
      )
      .run();
  }, 60000);
  afterAll(async () => {
    await sql?.end();
  });
  it('creates independent campus plans and saves completion', async () => {
    const templateId = await createWorkflowTemplate(db, {
      name: 'Campus care',
      fellowshipId: null,
      trigger: 'manual',
      steps: [{ title: 'Welcome visit', daysAfterStart: 0 }],
      enabled: true,
    });
    const input = {
      templateId,
      fellowshipId: null,
      personId: 99002,
      assigneeId: 99001,
      requestKey: crypto.randomUUID(),
      startAt: '2026-09-16T15:00:00Z',
    };
    const runId = await startWorkflow(db, input);
    expect(await startWorkflow(db, input)).toBe(runId);
    const tasks = await listWorkflowTasks(db);
    expect(tasks).toHaveLength(1);
    await updateWorkflowTask(
      db,
      tasks[0].id,
      { status: 'completed', notes: 'Welcome visit complete.' },
      { personId: 99001, canManage: false },
    );
    expect((await listWorkflowTasks(db))[0].status).toBe('completed');
  });
  it('supports optional fellowships, idempotent enrollment, and composite campus boundaries', async () => {
    const fellowshipId = await createFellowship(db, {
      name: 'Neighborhood',
      slug: 'neighborhood',
      description: 'Meet nearby',
      meetingDetails: 'Fridays',
      coordinatorId: 99001,
    });
    const group = await db
      .prepare("INSERT INTO groups(name) VALUES('Home group') RETURNING id")
      .first<{ id: number }>();
    await assignFellowshipGroup(db, fellowshipId, group!.id);
    await createWorkflowTemplate(db, {
      name: 'Fellowship welcome',
      fellowshipId,
      trigger: 'member_added',
      steps: [{ title: 'Contact member', daysAfterStart: 1 }],
      enabled: true,
    });
    await saveFellowshipMember(db, fellowshipId, 99002, 'member');
    await saveFellowshipMember(db, fellowshipId, 99002, 'member');
    expect(await listWorkflowTasks(db, { fellowshipId })).toHaveLength(1);
    await sql!.unsafe(
      "INSERT INTO campuses(id,slug,name) VALUES(99003,'east','East')",
    );
    await expect(
      sql!.unsafe(
        'INSERT INTO fellowship_groups(campus_id,group_id,fellowship_id) VALUES(99003,$1,$2)',
        [group!.id, fellowshipId],
      ),
    ).rejects.toThrow();
  });
});
