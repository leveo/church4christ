// Serving-plan writes. This slice ships only respondToAssignment (the email
// Accept/Decline handler); the rest of the plan/roster mutations arrive in
// slice 6, which extends this file.

export type RespondAction = 'accept' | 'decline';
export type RespondResult = { ok: true } | { ok: false; reason: 'past' | 'notfound' };

/**
 * A volunteer accepts or declines a serving request via their single-use respond
 * link. Scoped to `personId` (the token's owner) so a token can only touch its
 * own assignment. Refuses to rewrite serving history for a service that has
 * already happened — `plan_date` earlier than yesterday returns
 * `{ ok: false, reason: 'past' }` (a 1-day grace absorbs timezone slop). Accept
 * sets status 'C' and clears any prior decline reason; decline sets 'D' and
 * stores the reason. Returns `{ ok: false, reason: 'notfound' }` when no such
 * assignment belongs to the person.
 */
export async function respondToAssignment(
  db: D1Database,
  assignmentId: number,
  personId: number,
  action: RespondAction,
  reason: string | null,
): Promise<RespondResult> {
  const status = action === 'accept' ? 'C' : 'D';
  const declineReason = action === 'accept' ? null : reason;

  // The WHERE clause is the guard: right person, live assignment, and a plan
  // whose date is not in the past. changes>0 means all held and we mutated.
  const res = await db
    .prepare(
      `UPDATE roster_assignments
       SET status = ?1, decline_reason = ?2, responded_at = datetime('now')
       WHERE id = ?3 AND person_id = ?4 AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM plans
                       WHERE plans.id = roster_assignments.plan_id
                         AND plans.deleted_at IS NULL
                         AND plans.plan_date >= date('now', '-1 day'))`,
    )
    .bind(status, declineReason, assignmentId, personId)
    .run();
  if (res.meta.changes > 0) return { ok: true };

  // Nothing changed: distinguish "belongs to someone else / gone" from "in the
  // past" so the page can show the right message.
  const owned = await db
    .prepare(
      `SELECT 1 AS x FROM roster_assignments WHERE id = ? AND person_id = ? AND deleted_at IS NULL`,
    )
    .bind(assignmentId, personId)
    .first<{ x: number }>();
  return owned ? { ok: false, reason: 'past' } : { ok: false, reason: 'notfound' };
}
