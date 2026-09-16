import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scopeDatabase } from '../src/lib/campusScope';
import {
  createFellowship,
  assignFellowshipGroup,
  saveFellowshipMember,
  listFellowships,
} from '../src/lib/fellowshipDb';
import {
  createWorkflowTemplate,
  startWorkflow,
  updateWorkflowTask,
  listWorkflowTasks,
  setWorkflowTemplateEnabled,
  cancelWorkflow,
} from '../src/lib/workflowDb';
import {
  enrollCampusWorkflows,
  runWorkflowReminders,
} from '../src/lib/workflowReminders';
import { clearModuleCache } from '../src/lib/modules';
const db = scopeDatabase(env.DB, 1);
const steps = [
  { title: 'Make first contact', daysAfterStart: 0 },
  { title: 'Arrange a welcome visit', daysAfterStart: 7 },
];
let fellowshipId: number;
beforeEach(async () => {
  vi.restoreAllMocks();
  clearModuleCache();
  for (const table of [
    'workflow_tasks',
    'workflow_runs',
    'workflow_templates',
    'fellowship_members',
    'fellowship_groups',
    'fellowships',
    'groups',
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare('UPDATE campus_memberships SET active=1').run();
  await env.DB.exec(
    "INSERT OR IGNORE INTO people (id,display_name,email) VALUES (99001,'Care Coordinator','care@example.test'),(99002,'New Member','member@example.test'); INSERT OR IGNORE INTO campuses (id,slug,name) VALUES (99002,'east-test','East Campus');",
  );
  fellowshipId = await createFellowship(db, {
    name: 'Community Fellowship',
    slug: 'community',
    description: 'Grow together',
    meetingDetails: 'Fridays at 7 PM',
    coordinatorId: 99001,
  });
});
describe('fellowships and workflows', () => {
  it('keeps groups and fellowship members inside their campus', async () => {
    const group = await db
      .prepare("INSERT INTO groups (name) VALUES ('Home Group') RETURNING id")
      .first<{ id: number }>();
    await assignFellowshipGroup(db, fellowshipId, group!.id);
    const foreign = scopeDatabase(env.DB, 99002);
    expect(await listFellowships(foreign)).toEqual([]);
    await expect(
      assignFellowshipGroup(foreign, fellowshipId, group!.id),
    ).rejects.toThrow();
    await expect(
      saveFellowshipMember(foreign, fellowshipId, 99002, 'member'),
    ).rejects.toThrow();
    expect((await listFellowships(db))[0].group_count).toBe(1);
  });
  it('enrolls a member once and creates automatic follow-up tasks atomically', async () => {
    await createWorkflowTemplate(db, {
      name: 'Welcome journey',
      fellowshipId,
      trigger: 'member_added',
      steps,
      enabled: true,
    });
    await saveFellowshipMember(db, fellowshipId, 99002, 'member');
    await saveFellowshipMember(db, fellowshipId, 99002, 'member');
    const tasks = await listWorkflowTasks(db);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.assignee_id === 99001)).toBe(true);
    expect(tasks.map((t) => t.title)).toEqual(steps.map((s) => s.title));
  });
  it('deduplicates manual starts and rejects an assignee outside the campus', async () => {
    const templateId = await createWorkflowTemplate(db, {
      name: 'Care visit',
      fellowshipId,
      trigger: 'manual',
      steps,
      enabled: true,
    });
    const input = {
      templateId,
      fellowshipId,
      personId: 99002,
      assigneeId: 99001,
      requestKey: crypto.randomUUID(),
      startAt: '2026-09-16T15:00:00Z',
    };
    await startWorkflow(db, input);
    await startWorkflow(db, input);
    expect(await listWorkflowTasks(db)).toHaveLength(2);
    await env.DB.prepare(
      'UPDATE campus_memberships SET active=0 WHERE person_id=99001',
    ).run();
    await expect(
      startWorkflow(db, { ...input, requestKey: crypto.randomUUID() }),
    ).rejects.toThrow();
  });
  it('only allows the assigned person to complete their own task without staff access', async () => {
    const templateId = await createWorkflowTemplate(db, {
      name: 'Care visit',
      fellowshipId,
      trigger: 'manual',
      steps,
      enabled: true,
    });
    await startWorkflow(db, {
      templateId,
      fellowshipId,
      personId: 99002,
      assigneeId: 99001,
      requestKey: crypto.randomUUID(),
      startAt: '2026-09-16T15:00:00Z',
    });
    const task = (await listWorkflowTasks(db))[0];
    await expect(
      updateWorkflowTask(
        db,
        task.id,
        { status: 'completed', notes: 'Contact made' },
        { personId: 99002, canManage: false },
      ),
    ).rejects.toThrow();
    await updateWorkflowTask(
      db,
      task.id,
      { status: 'completed', notes: 'Contact made' },
      { personId: 99001, canManage: false },
    );
    expect(
      (await listWorkflowTasks(db)).find((t) => t.id === task.id)?.status,
    ).toBe('completed');
  });
  it('claims due mail once across concurrent passes, and suppresses completed tasks', async () => {
    const templateId = await createWorkflowTemplate(db, {
      name: 'Welcome',
      fellowshipId,
      trigger: 'manual',
      steps,
      enabled: true,
    });
    await startWorkflow(db, {
      templateId,
      fellowshipId,
      personId: 99002,
      assigneeId: 99001,
      requestKey: crypto.randomUUID(),
      startAt: '2026-09-16T15:00:00Z',
    });
    const send = vi.fn().mockResolvedValue(true);
    const opts = { now: '2026-09-16T16:00:00Z', send };
    await Promise.all([
      runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, opts),
      runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, opts),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const task = (await listWorkflowTasks(db))[0];
    await updateWorkflowTask(
      db,
      task.id,
      { status: 'completed', notes: '' },
      { personId: 99001, canManage: false },
    );
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-17T16:00:00Z',
      send,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries failed delivery with backoff and obeys the email kill switch', async () => {
    const templateId = await createWorkflowTemplate(db, {
      name: 'Welcome',
      fellowshipId,
      trigger: 'manual',
      steps: steps.slice(0, 1),
      enabled: true,
    });
    await startWorkflow(db, {
      templateId,
      fellowshipId,
      personId: 99002,
      assigneeId: 99001,
      requestKey: crypto.randomUUID(),
      startAt: '2026-09-16T15:00:00Z',
    });
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await runWorkflowReminders({}, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:01:00Z',
      send,
    });
    expect(send).toHaveBeenCalledTimes(1);
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T17:00:00Z',
      send,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('direct campus workflows and delivery safeguards', () => {
  async function campusRun() {
    const templateId = await createWorkflowTemplate(db, {
      name: 'Campus welcome',
      fellowshipId: null,
      trigger: 'manual',
      steps: steps.slice(0, 1),
      enabled: true,
    });
    const runId = await startWorkflow(db, {
      templateId,
      fellowshipId: null,
      personId: 99002,
      assigneeId: 99001,
      requestKey: crypto.randomUUID(),
      startAt: '2026-09-16T15:00:00Z',
    });
    return { templateId, runId, task: (await listWorkflowTasks(db))[0] };
  }
  it('works without a fellowship and sends only the assigned person a private task link', async () => {
    await campusRun();
    await env.DB.prepare('DELETE FROM fellowships').run();
    const send = vi.fn().mockResolvedValue(true);
    await runWorkflowReminders(
      { WORKFLOW_EMAIL_ENABLED: '1', APP_ORIGIN: 'https://church.example' },
      env.DB,
      { now: '2026-09-16T16:00:00Z', send },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][2];
    expect(message.to).toBe('care@example.test');
    expect(message.text).toContain('/en/my/workflows?campus=main');
    expect(message.text).not.toContain('New Member');
    expect(message.text).not.toContain('Make first contact');
  });
  it('enrolls new campus members once without requiring a fellowship', async () => {
    await createWorkflowTemplate(db, {
      name: 'Automatic campus welcome',
      fellowshipId: null,
      trigger: 'member_added',
      steps: steps.slice(0, 1),
      enabled: true,
      assigneeId: 99001,
    });
    await env.DB.prepare(
      "UPDATE workflow_templates SET created_at='2026-09-16 00:00:00'",
    ).run();
    await env.DB.prepare(
      "UPDATE campus_memberships SET created_at='2026-09-15 00:00:00' WHERE person_id=99001",
    ).run();
    await env.DB.prepare(
      "UPDATE campus_memberships SET created_at='2026-09-17 00:00:00' WHERE person_id=99002",
    ).run();
    await enrollCampusWorkflows({}, env.DB);
    await enrollCampusWorkflows({}, env.DB);
    expect(await listWorkflowTasks(db)).toHaveLength(1);
    expect((await listWorkflowTasks(db))[0].fellowship_id).toBeNull();
  });
  it('pauses sends for paused templates and cancelled workflows', async () => {
    const { templateId, runId } = await campusRun();
    const send = vi.fn().mockResolvedValue(true);
    await setWorkflowTemplateEnabled(db, templateId, false);
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
    await setWorkflowTemplateEnabled(db, templateId, true);
    await cancelWorkflow(db, runId, 99001);
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('never automatically resends when a worker loses an in-flight delivery', async () => {
    const { task } = await campusRun();
    await db
      .prepare(
        "UPDATE workflow_tasks SET delivery_state='sending',lease_until='2026-09-16T15:30:00.000Z',lease_token='lost' WHERE id=?",
      )
      .bind(task.id)
      .run();
    const send = vi.fn().mockResolvedValue(true);
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect((await listWorkflowTasks(db))[0].delivery_state).toBe('uncertain');
  });
  it('obeys campus module overrides and removed assignees', async () => {
    await campusRun();
    await env.DB.prepare(
      "INSERT INTO campus_modules(campus_id,module_key,enabled) VALUES(1,'groups',0)",
    ).run();
    const send = vi.fn().mockResolvedValue(true);
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
    await env.DB.prepare('DELETE FROM campus_modules').run();
    await env.DB.prepare(
      'UPDATE campus_memberships SET active=0 WHERE person_id=99001',
    ).run();
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('reschedules tasks without sending a reminder at the old due date', async () => {
    const { task } = await campusRun();
    await updateWorkflowTask(
      db,
      task.id,
      { status: 'pending', notes: '', dueAt: '2026-09-20T15:00:00Z' },
      { personId: 99001, canManage: true },
    );
    const send = vi.fn().mockResolvedValue(true);
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-16T16:00:00Z',
      send,
    });
    expect(send).not.toHaveBeenCalled();
    await runWorkflowReminders({ WORKFLOW_EMAIL_ENABLED: '1' }, env.DB, {
      now: '2026-09-20T16:00:00Z',
      send,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
