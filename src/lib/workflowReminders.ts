import type { AppDb } from './appDb';
import { scopeDatabase } from './campusScope';
import { getEffectiveCampusModules } from './campusDb';
import { getEnabledModules } from './modules';
import { getBackend, type DbEnv } from './dbProvider';
import {
  escapeHtml,
  sendEmail,
  type EmailEnv,
  type SendEmailInput,
} from './email';
import { buildAutomaticWorkflowStatements } from './workflowDb';
import { utcTime } from './communityValidation';

export type WorkflowEmailEnv = EmailEnv &
  DbEnv & { WORKFLOW_EMAIL_ENABLED?: string };
type Send = (
  env: EmailEnv,
  db: AppDb,
  input: SendEmailInput,
) => Promise<boolean>;
type DueTask = {
  id: string;
  campus_id: number;
  assignee_id: number;
  run_id: string;
  delivery_attempts: number;
};
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;
/** Bounded enrollment sweep covers new campus members without requiring a fellowship. */
export async function enrollCampusWorkflows(
  env: WorkflowEmailEnv,
  rawDb: AppDb,
): Promise<void> {
  const modules = await getEnabledModules(rawDb, getBackend(env));
  if (!modules.has('groups')) return;
  const pending = await rawDb
    .prepare(
      `SELECT DISTINCT wt.campus_id,cm.person_id FROM workflow_templates wt
    JOIN campus_memberships cm ON cm.campus_id=wt.campus_id AND cm.active=1
    JOIN campuses c ON c.id=wt.campus_id AND c.active=1
    WHERE wt.enabled=1 AND wt.trigger_type='member_added' AND wt.fellowship_id IS NULL
    AND cm.created_at>=wt.created_at AND NOT EXISTS (
      SELECT 1 FROM workflow_runs r WHERE r.template_id=wt.id AND r.person_id=cm.person_id)
    ORDER BY wt.campus_id,cm.person_id LIMIT 20`,
    )
    .all<{ campus_id: number; person_id: number }>();
  for (const row of pending.results) {
    if (
      !(await getEffectiveCampusModules(rawDb, row.campus_id, modules)).has(
        'groups',
      )
    )
      continue;
    const db = scopeDatabase(rawDb, row.campus_id);
    try {
      const statements = await buildAutomaticWorkflowStatements(
        db,
        null,
        row.person_id,
      );
      if (statements.length) await db.batch(statements);
    } catch {
      console.warn(
        'community workflow enrollment needs a valid member and assignee',
        { campusId: row.campus_id },
      );
    }
  }
}
/** Claims are atomic. Expired in-flight sends are uncertain, never automatically resent. */
export async function runWorkflowReminders(
  env: WorkflowEmailEnv,
  rawDb: AppDb,
  options: { now?: string; send?: Send } = {},
): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  if (env.WORKFLOW_EMAIL_ENABLED !== '1') return result;
  const modules = await getEnabledModules(rawDb, getBackend(env));
  if (!modules.has('groups')) return result;
  const now = utcTime(options.now ?? new Date().toISOString());
  await rawDb
    .prepare(
      `UPDATE workflow_tasks SET delivery_state='uncertain',lease_token=NULL,lease_until=NULL
    WHERE delivery_state='sending' AND lease_until<=?`,
    )
    .bind(now)
    .run();
  const candidates = await rawDb
    .prepare(
      `SELECT t.id,t.campus_id,t.assignee_id,t.run_id,t.delivery_attempts FROM workflow_tasks t
    JOIN workflow_runs r ON r.id=t.run_id AND r.status='active'
    JOIN workflow_templates wt ON wt.id=r.template_id AND wt.enabled=1
    JOIN campuses c ON c.id=t.campus_id AND c.active=1
    WHERE t.status IN ('pending','in_progress') AND t.reminder_enabled=1 AND t.next_reminder_at<=?
    AND t.delivery_state IN ('pending','sent','failed') AND t.delivery_attempts<?
    AND (r.fellowship_id IS NULL OR EXISTS (SELECT 1 FROM fellowships f WHERE f.id=r.fellowship_id AND f.active=1))
    ORDER BY t.next_reminder_at,t.id LIMIT ${BATCH_SIZE}`,
    )
    .bind(now, MAX_ATTEMPTS)
    .all<DueTask>();
  for (const candidate of candidates.results) {
    if (
      !(
        await getEffectiveCampusModules(rawDb, candidate.campus_id, modules)
      ).has('groups')
    )
      continue;
    const db = scopeDatabase(rawDb, candidate.campus_id);
    const lease = crypto.randomUUID();
    const leaseUntil = new Date(Date.parse(now) + 10 * 60000).toISOString();
    const claim = await db
      .prepare(
        `UPDATE workflow_tasks SET delivery_state='sending',lease_token=?,lease_until=?,delivery_attempts=delivery_attempts+1
      WHERE id=? AND status IN ('pending','in_progress') AND reminder_enabled=1 AND next_reminder_at<=?
      AND delivery_state IN ('pending','sent','failed') AND delivery_attempts<?`,
      )
      .bind(lease, leaseUntil, candidate.id, now, MAX_ATTEMPTS)
      .run();
    if (claim.meta.changes !== 1) continue;
    // Re-read eligibility after claiming: no cached recipient addresses or authority.
    const task = await db
      .prepare(
        `SELECT t.title,t.due_at,p.email,p.display_name,c.slug AS campus_slug
      FROM workflow_tasks t JOIN workflow_runs r ON r.id=t.run_id AND r.status='active'
      JOIN workflow_templates wt ON wt.id=r.template_id AND wt.enabled=1
      JOIN people p ON p.id=t.assignee_id AND p.deleted_at IS NULL
      JOIN people subject ON subject.id=r.person_id AND subject.deleted_at IS NULL
      JOIN campuses c ON c.id=t.campus_id AND c.active=1
      WHERE t.id=? AND t.lease_token=? AND t.status IN ('pending','in_progress') AND t.reminder_enabled=1
      AND (r.fellowship_id IS NULL OR (EXISTS(SELECT 1 FROM fellowships f WHERE f.id=r.fellowship_id AND f.active=1)
        AND (wt.trigger_type='manual' OR EXISTS(SELECT 1 FROM fellowship_members fm WHERE fm.fellowship_id=r.fellowship_id AND fm.person_id=r.person_id AND fm.active=1))))`,
      )
      .bind(candidate.id, lease)
      .first<{
        title: string;
        due_at: string;
        email: string;
        display_name: string;
        campus_slug: string;
      }>();
    if (!task) {
      await db
        .prepare(
          "UPDATE workflow_tasks SET delivery_state='pending',lease_token=NULL,lease_until=NULL,next_reminder_at=?,delivery_attempts=0 WHERE id=? AND lease_token=?",
        )
        .bind(
          new Date(Date.parse(now) + 86400000).toISOString(),
          candidate.id,
          lease,
        )
        .run();
      continue;
    }
    const link = new URL(
      '/en/my/workflows',
      env.APP_ORIGIN ?? 'https://church4christ.example',
    );
    link.searchParams.set('campus', task.campus_slug);
    // Keep care notes, subject names and task details behind authenticated access.
    const text = `Hello ${task.display_name},\n\nYou have a community follow-up task due ${task.due_at.slice(0, 16).replace('T', ' ')} UTC.\nSign in to review your task: ${link}\n`;
    let sent: boolean;
    try {
      sent = await (options.send ?? sendEmail)(env, db, {
        to: task.email,
        toName: task.display_name,
        kind: 'workflow_reminder',
        subject: 'Community follow-up reminder',
        text,
        html: `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`,
        detail: `task:${candidate.id}`,
        redactDevLogBody: true,
      });
    } catch {
      await db
        .prepare(
          "UPDATE workflow_tasks SET delivery_state='uncertain',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
        )
        .bind(candidate.id, lease)
        .run();
      result.failed++;
      continue;
    }
    const next = new Date(
      Date.parse(now) +
        (sent
          ? 86400000
          : Math.min(24, 2 ** candidate.delivery_attempts) * 3600000),
    ).toISOString();
    await db
      .prepare(
        `UPDATE workflow_tasks SET delivery_state=?,next_reminder_at=?,delivery_attempts=?,last_sent_at=CASE WHEN ?=1 THEN ? ELSE last_sent_at END,
      lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,
      )
      .bind(
        sent ? 'sent' : 'failed',
        next,
        sent ? 0 : candidate.delivery_attempts + 1,
        sent ? 1 : 0,
        now,
        candidate.id,
        lease,
      )
      .run();
    if (sent) result.sent++;
    else result.failed++;
  }
  return result;
}
export async function runCommunityWorkflowPass(
  env: WorkflowEmailEnv,
  db: AppDb,
): Promise<void> {
  await enrollCampusWorkflows(env, db);
  await runWorkflowReminders(env, db);
}
