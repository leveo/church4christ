import type { AppDb } from './appDb';
import {
  cleanText,
  positiveId,
  requireCampus,
  requireFellowship,
  requirePerson,
} from './communityValidation';
import { buildAutomaticWorkflowStatements } from './workflowDb';

export interface FellowshipInput {
  name: string;
  slug: string;
  description: string;
  meetingDetails: string;
  coordinatorId: number | null;
}
export interface FellowshipRow {
  id: number;
  campus_id: number;
  name: string;
  slug: string;
  description: string;
  meeting_details: string;
  coordinator_id: number | null;
  active: number;
  group_count: number;
  member_count: number;
}
export async function listFellowships(db: AppDb): Promise<FellowshipRow[]> {
  return (
    await db
      .prepare(
        `SELECT f.*,
    (SELECT COUNT(*) FROM fellowship_groups fg JOIN groups g ON g.id=fg.group_id AND g.deleted_at IS NULL WHERE fg.fellowship_id=f.id) AS group_count,
    (SELECT COUNT(*) FROM fellowship_members fm JOIN people p ON p.id=fm.person_id AND p.deleted_at IS NULL WHERE fm.fellowship_id=f.id AND fm.active=1) AS member_count
    FROM fellowships f ORDER BY f.active DESC,f.name,f.id`,
      )
      .all<FellowshipRow>()
  ).results;
}
async function validate(db: AppDb, input: FellowshipInput) {
  requireCampus(db);
  const slug = cleanText(input.slug, 64).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error(
      'Use lowercase letters, numbers, and hyphens for the slug.',
    );
  if (input.coordinatorId !== null)
    await requirePerson(db, input.coordinatorId);
  return [
    slug,
    cleanText(input.name, 120),
    cleanText(input.description, 5000, false),
    cleanText(input.meetingDetails, 500, false),
    input.coordinatorId,
  ];
}
export async function createFellowship(
  db: AppDb,
  input: FellowshipInput,
): Promise<number> {
  const values = await validate(db, input);
  const row = await db
    .prepare(
      `INSERT INTO fellowships (slug,name,description,meeting_details,coordinator_id) VALUES (?,?,?,?,?) RETURNING id`,
    )
    .bind(...values)
    .first<{ id: number }>();
  return row!.id;
}
export async function updateFellowship(
  db: AppDb,
  id: number,
  input: FellowshipInput,
): Promise<void> {
  const values = await validate(db, input);
  const changed = await db
    .prepare(
      `UPDATE fellowships SET slug=?,name=?,description=?,meeting_details=?,coordinator_id=? WHERE id=?`,
    )
    .bind(...values, positiveId(id))
    .run();
  if (!changed.meta.changes) throw new Error('Fellowship not found.');
}
export async function setFellowshipActive(
  db: AppDb,
  id: number,
  active: boolean,
): Promise<void> {
  requireCampus(db);
  await db
    .prepare('UPDATE fellowships SET active=? WHERE id=?')
    .bind(active ? 1 : 0, positiveId(id))
    .run();
}
/** NULL means the group is managed directly by its campus. Memberships are unchanged. */
export async function assignFellowshipGroup(
  db: AppDb,
  fellowshipId: number | null,
  groupId: number,
): Promise<void> {
  await requireFellowship(db, fellowshipId);
  if (
    !(await db
      .prepare('SELECT id FROM groups WHERE id=? AND deleted_at IS NULL')
      .bind(positiveId(groupId))
      .first())
  )
    throw new Error('Group not found in this campus.');
  if (fellowshipId === null) {
    await db
      .prepare('DELETE FROM fellowship_groups WHERE group_id=?')
      .bind(groupId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO fellowship_groups (group_id,fellowship_id) VALUES (?,?)
      ON CONFLICT(group_id) DO UPDATE SET fellowship_id=excluded.fellowship_id`,
      )
      .bind(groupId, fellowshipId)
      .run();
  }
}
export async function listCommunityGroups(db: AppDb) {
  return (
    await db
      .prepare(
        `SELECT g.id,g.name,fg.fellowship_id,f.name AS fellowship_name,
    (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id AND gm.removed_at IS NULL) AS member_count
    FROM groups g LEFT JOIN fellowship_groups fg ON fg.group_id=g.id
    LEFT JOIN fellowships f ON f.id=fg.fellowship_id WHERE g.deleted_at IS NULL ORDER BY g.name,g.id`,
      )
      .all<{
        id: number;
        name: string;
        fellowship_id: number | null;
        fellowship_name: string | null;
        member_count: number;
      }>()
  ).results;
}
export async function listCommunityMembers(
  db: AppDb,
  fellowshipId: number | null,
) {
  const campusId = requireCampus(db);
  if (fellowshipId === null) {
    return (
      await db
        .prepare(
          `SELECT p.id,p.display_name,cm.role,cm.active FROM people p
      JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=? WHERE p.deleted_at IS NULL ORDER BY p.display_name`,
        )
        .bind(campusId)
        .all<{
          id: number;
          display_name: string;
          role: string;
          active: number;
        }>()
    ).results;
  }
  return (
    await db
      .prepare(
        `SELECT p.id,p.display_name,fm.role,fm.active FROM fellowship_members fm
    JOIN people p ON p.id=fm.person_id AND p.deleted_at IS NULL WHERE fm.fellowship_id=? ORDER BY p.display_name`,
      )
      .bind(fellowshipId)
      .all<{ id: number; display_name: string; role: string; active: number }>()
  ).results;
}
export async function saveFellowshipMember(
  db: AppDb,
  fellowshipId: number,
  personId: number,
  role: 'member' | 'coordinator',
  active = true,
): Promise<void> {
  await requireFellowship(db, fellowshipId);
  await requirePerson(db, personId);
  if (!['member', 'coordinator'].includes(role))
    throw new Error('Choose a valid fellowship role.');
  const statements = [
    db
      .prepare(
        `INSERT INTO fellowship_members (fellowship_id,person_id,role,active) VALUES (?,?,?,?)
    ON CONFLICT(fellowship_id,person_id) DO UPDATE SET role=excluded.role,active=excluded.active`,
      )
      .bind(fellowshipId, personId, role, active ? 1 : 0),
  ];
  if (active)
    statements.push(
      ...(await buildAutomaticWorkflowStatements(db, fellowshipId, personId)),
    );
  await db.batch(statements);
}
