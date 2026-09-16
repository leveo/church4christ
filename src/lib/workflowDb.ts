import type { AppDb, AppStatement } from './appDb';
import {
  cleanText,
  positiveId,
  requireCampus,
  requireFellowship,
  requirePerson,
  utcTime,
} from './communityValidation';

export interface WorkflowStep {
  title: string;
  daysAfterStart: number;
}
export interface WorkflowTemplateInput {
  name: string;
  fellowshipId: number | null;
  trigger: 'manual' | 'member_added';
  steps: WorkflowStep[];
  enabled: boolean;
  assigneeId?: number | null;
}
export interface WorkflowTemplate {
  id: number;
  fellowship_id: number | null;
  name: string;
  trigger_type: 'manual' | 'member_added';
  steps_json: string;
  default_assignee_id: number | null;
  enabled: number;
  created_at: string;
}
export interface WorkflowTask {
  id: string;
  run_id: string;
  title: string;
  step_index: number;
  assignee_id: number;
  assignee_name: string;
  due_at: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  notes: string;
  reminder_enabled: number;
  delivery_state: string;
  delivery_attempts: number;
  last_sent_at: string | null;
  run_name: string;
  run_status: string;
  fellowship_id: number | null;
  person_name: string;
  person_id: number;
}
export function validateSteps(steps: WorkflowStep[]): WorkflowStep[] {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20)
    throw new Error('Add between 1 and 20 workflow steps.');
  return steps.map((step) => {
    if (
      !Number.isInteger(step.daysAfterStart) ||
      step.daysAfterStart < 0 ||
      step.daysAfterStart > 365
    )
      throw new Error(
        'Step due dates must be between 0 and 365 days after the start.',
      );
    return {
      title: cleanText(step.title, 160),
      daysAfterStart: step.daysAfterStart,
    };
  });
}
export async function createWorkflowTemplate(
  db: AppDb,
  input: WorkflowTemplateInput,
): Promise<number> {
  await requireFellowship(db, input.fellowshipId);
  if (!['manual', 'member_added'].includes(input.trigger))
    throw new Error('Choose a valid workflow trigger.');
  let assigneeId = input.assigneeId ?? null;
  if (assigneeId === null && input.fellowshipId !== null) {
    assigneeId =
      (
        await db
          .prepare('SELECT coordinator_id FROM fellowships WHERE id=?')
          .bind(input.fellowshipId)
          .first<{ coordinator_id: number | null }>()
      )?.coordinator_id ?? null;
  }
  if (assigneeId !== null) await requirePerson(db, assigneeId);
  if (input.trigger === 'member_added' && assigneeId === null)
    throw new Error('Choose a default assignee for automatic follow-up.');
  const row = await db
    .prepare(
      `INSERT INTO workflow_templates (fellowship_id,name,steps_json,trigger_type,enabled,default_assignee_id)
    VALUES (?,?,?,?,?,?) RETURNING id`,
    )
    .bind(
      input.fellowshipId,
      cleanText(input.name, 120),
      JSON.stringify(validateSteps(input.steps)),
      input.trigger,
      input.enabled ? 1 : 0,
      assigneeId,
    )
    .first<{ id: number }>();
  return row!.id;
}
export async function listWorkflowTemplates(
  db: AppDb,
): Promise<WorkflowTemplate[]> {
  return (
    await db
      .prepare('SELECT * FROM workflow_templates ORDER BY name,id')
      .all<WorkflowTemplate>()
  ).results;
}
export async function setWorkflowTemplateEnabled(
  db: AppDb,
  id: number,
  enabled: boolean,
): Promise<void> {
  requireCampus(db);
  await db
    .prepare('UPDATE workflow_templates SET enabled=? WHERE id=?')
    .bind(enabled ? 1 : 0, positiveId(id))
    .run();
}
export interface StartWorkflowInput {
  templateId: number;
  fellowshipId: number | null;
  personId: number;
  assigneeId: number;
  requestKey: string;
  startAt?: string;
}
async function buildRun(
  db: AppDb,
  template: WorkflowTemplate,
  input: StartWorkflowInput,
): Promise<{ id: string; statements: AppStatement[] }> {
  await requireFellowship(db, input.fellowshipId);
  await requirePerson(db, input.personId);
  await requirePerson(db, input.assigneeId);
  if (template.enabled !== 1 || template.fellowship_id !== input.fellowshipId)
    throw new Error('Choose an enabled template for this community.');
  const startAt = utcTime(input.startAt ?? new Date().toISOString());
  const key = cleanText(input.requestKey, 160);
  const id = crypto.randomUUID();
  const statements = [
    db
      .prepare(
        `INSERT INTO workflow_runs (id,template_id,fellowship_id,person_id,name,request_key)
    VALUES (?,?,?,?,?,?) ON CONFLICT(campus_id,request_key) DO NOTHING`,
      )
      .bind(
        id,
        template.id,
        input.fellowshipId,
        input.personId,
        template.name,
        key,
      ),
  ];
  validateSteps(JSON.parse(template.steps_json)).forEach((step, index) => {
    const due = new Date(
      new Date(startAt).getTime() + step.daysAfterStart * 86400000,
    ).toISOString();
    statements.push(
      db
        .prepare(
          `INSERT INTO workflow_tasks (id,run_id,step_index,title,assignee_id,due_at,next_reminder_at)
      SELECT ?,id,?,?,?,?,? FROM workflow_runs WHERE id=?`,
        )
        .bind(
          crypto.randomUUID(),
          index,
          step.title,
          input.assigneeId,
          due,
          due,
          id,
        ),
    );
  });
  return { id, statements };
}
export async function startWorkflow(
  db: AppDb,
  input: StartWorkflowInput,
): Promise<string> {
  requireCampus(db);
  const template = await db
    .prepare('SELECT * FROM workflow_templates WHERE id=?')
    .bind(positiveId(input.templateId))
    .first<WorkflowTemplate>();
  if (!template) throw new Error('Workflow template not found.');
  const run = await buildRun(db, template, input);
  await db.batch(run.statements);
  const existing = await db
    .prepare(
      'SELECT id,template_id,person_id,fellowship_id FROM workflow_runs WHERE request_key=?',
    )
    .bind(input.requestKey)
    .first<{
      id: string;
      template_id: number;
      person_id: number;
      fellowship_id: number | null;
    }>();
  if (
    !existing ||
    existing.template_id !== input.templateId ||
    existing.person_id !== input.personId ||
    existing.fellowship_id !== input.fellowshipId
  )
    throw new Error('This request has already been used for another workflow.');
  return existing.id;
}
/** Stable enrollment keys make retries safe; callers batch enrollment and tasks together. */
export async function buildAutomaticWorkflowStatements(
  db: AppDb,
  fellowshipId: number | null,
  personId: number,
  templateId?: number,
): Promise<AppStatement[]> {
  const templates = await db
    .prepare(
      `SELECT * FROM workflow_templates WHERE enabled=1 AND trigger_type='member_added'
    AND fellowship_id ${fellowshipId === null ? 'IS NULL' : '= ?'} ${templateId === undefined ? '' : 'AND id=?'}`,
    )
    .bind(
      ...(fellowshipId === null ? [] : [fellowshipId]),
      ...(templateId === undefined ? [] : [templateId]),
    )
    .all<WorkflowTemplate>();
  const statements: AppStatement[] = [];
  for (const template of templates.results) {
    if (template.default_assignee_id === null) continue;
    const run = await buildRun(db, template, {
      templateId: template.id,
      fellowshipId,
      personId,
      assigneeId: template.default_assignee_id,
      requestKey: `member:${template.id}:${personId}`,
    });
    statements.push(...run.statements);
  }
  return statements;
}
export async function listWorkflowTasks(
  db: AppDb,
  filter: { assigneeId?: number; fellowshipId?: number | null } = {},
): Promise<WorkflowTask[]> {
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (filter.assigneeId !== undefined) {
    where.push('t.assignee_id=?');
    bindings.push(filter.assigneeId);
  }
  if (filter.fellowshipId !== undefined) {
    where.push(
      `r.fellowship_id ${filter.fellowshipId === null ? 'IS NULL' : '=?'}`,
    );
    if (filter.fellowshipId !== null) bindings.push(filter.fellowshipId);
  }
  return (
    await db
      .prepare(
        `SELECT t.*,r.name AS run_name,r.status AS run_status,r.fellowship_id,r.person_id,
    p.display_name AS person_name,a.display_name AS assignee_name FROM workflow_tasks t
    JOIN workflow_runs r ON r.id=t.run_id JOIN people p ON p.id=r.person_id AND p.deleted_at IS NULL
    JOIN people a ON a.id=t.assignee_id AND a.deleted_at IS NULL
    WHERE 1=1 ${where.map((w) => 'AND ' + w).join(' ')} ORDER BY t.due_at,r.id,t.step_index LIMIT 500`,
      )
      .bind(...bindings)
      .all<WorkflowTask>()
  ).results;
}
export async function updateWorkflowTask(
  db: AppDb,
  id: string,
  input: {
    status: WorkflowTask['status'];
    notes: string;
    assigneeId?: number;
    reminderEnabled?: boolean;
    dueAt?: string;
  },
  actor: { personId: number; canManage: boolean },
): Promise<void> {
  requireCampus(db);
  await requirePerson(db, actor.personId);
  if (
    !['pending', 'in_progress', 'completed', 'cancelled'].includes(input.status)
  )
    throw new Error('Choose a valid task status.');
  const task = await db
    .prepare(
      `SELECT t.*,r.status AS run_status FROM workflow_tasks t JOIN workflow_runs r ON r.id=t.run_id WHERE t.id=?`,
    )
    .bind(id)
    .first<WorkflowTask>();
  if (!task || (!actor.canManage && task.assignee_id !== actor.personId))
    throw new Error('You cannot update this task.');
  if (task.run_status === 'cancelled')
    throw new Error('This workflow is cancelled.');
  if (
    !actor.canManage &&
    (input.assigneeId !== undefined ||
      input.reminderEnabled !== undefined ||
      input.dueAt !== undefined ||
      input.status === 'cancelled')
  )
    throw new Error(
      'Only a community administrator can reassign or cancel tasks.',
    );
  const assigneeId = input.assigneeId ?? task.assignee_id;
  if (input.assigneeId !== undefined) await requirePerson(db, assigneeId);
  const notes = cleanText(input.notes, 2000, false);
  const dueAt = input.dueAt === undefined ? task.due_at : utcTime(input.dueAt);
  const reset = assigneeId !== task.assignee_id || dueAt !== task.due_at;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE workflow_tasks SET status=?,notes=?,assignee_id=?,reminder_enabled=?,updated_by=?,updated_at=?,due_at=?,
      delivery_state=CASE WHEN ?=1 THEN 'pending' ELSE delivery_state END,
      delivery_attempts=CASE WHEN ?=1 THEN 0 ELSE delivery_attempts END,
      next_reminder_at=CASE WHEN ?=1 THEN ? ELSE next_reminder_at END WHERE id=? AND delivery_state<>'sending' AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=workflow_tasks.run_id AND r.status<>'cancelled')`,
      )
      .bind(
        input.status,
        notes,
        assigneeId,
        input.reminderEnabled === undefined
          ? task.reminder_enabled
          : input.reminderEnabled
            ? 1
            : 0,
        actor.personId,
        now,
        dueAt,
        reset ? 1 : 0,
        reset ? 1 : 0,
        reset ? 1 : 0,
        dueAt,
        id,
      ),
    db
      .prepare(
        `UPDATE workflow_runs SET status='completed' WHERE id=? AND status='active' AND NOT EXISTS (SELECT 1 FROM workflow_tasks t WHERE t.run_id=? AND t.status IN ('pending','in_progress'))`,
      )
      .bind(task.run_id, task.run_id),
    db
      .prepare(
        `UPDATE workflow_runs SET status='active' WHERE id=? AND status='completed' AND EXISTS (SELECT 1 FROM workflow_tasks t WHERE t.run_id=? AND t.status IN ('pending','in_progress'))`,
      )
      .bind(task.run_id, task.run_id),
  ]);
  const changed = await db
    .prepare('SELECT updated_at FROM workflow_tasks WHERE id=?')
    .bind(id)
    .first<{ updated_at: string }>();
  if (changed?.updated_at !== now)
    throw new Error('A reminder is being delivered. Try again shortly.');
}
export async function cancelWorkflow(
  db: AppDb,
  runId: string,
  actorId: number,
): Promise<void> {
  requireCampus(db);
  await db.batch([
    db
      .prepare("UPDATE workflow_runs SET status='cancelled' WHERE id=?")
      .bind(runId),
    db
      .prepare(
        "UPDATE workflow_tasks SET status='cancelled',updated_by=?,updated_at=? WHERE run_id=? AND status IN ('pending','in_progress')",
      )
      .bind(actorId, new Date().toISOString(), runId),
  ]);
}
/** An uncertain provider outcome requires a conscious retry; successful sends are never reset here. */
export async function retryWorkflowReminder(
  db: AppDb,
  id: string,
): Promise<void> {
  requireCampus(db);
  await db
    .prepare(
      `UPDATE workflow_tasks SET delivery_state='pending',delivery_attempts=0,lease_token=NULL,lease_until=NULL,next_reminder_at=?
    WHERE id=? AND delivery_state IN ('failed','uncertain') AND status IN ('pending','in_progress')`,
    )
    .bind(new Date().toISOString(), id)
    .run();
}
