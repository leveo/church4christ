// The event-logistics cancel cascade (see regLogistics.ts). A leaf module with no imports from the registration
// data layer, because regDb.ts (cancelRegistrationPromoting) and regManage.ts append these statements to their own
// cancel batches, and regLogistics.ts depends on regDb.ts.
import type { AppDb, AppStatement } from './appDb';

const int = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error('not_an_integer');
  return value;
};

/**
 * The statements that take the room, seat and group (and any room-leader, table-host or group-leader role) away
 * from every person on registration `registrationId` who is now cancelled, or from everyone when the registration
 * itself is cancelled or declined, plus one 'logistics_released' history row when anything was released.
 * Self-guarded on that state: a cancel path appends them AFTER its own status change in the same batch (ANDing
 * its `guardSql`, e.g. the drawer's held predicate), and they change nothing when nothing was cancelled. The
 * history row comes first because it must see the rows it reports.
 */
export function releaseLogisticsStatements(db: AppDb, registrationId: number, actor: number | null, guardSql = '1 = 1'): AppStatement[] {
  const id = int(registrationId);
  const gone = `(SELECT ga.id FROM reg_attendees ga JOIN registrations gr ON gr.id = ga.registration_id
                 WHERE ga.registration_id = ${id} AND (ga.status = 'cancelled' OR gr.status IN ('cancelled','declined')))`;
  const holds = (table: string) => `EXISTS (SELECT 1 FROM ${table} gx WHERE gx.attendee_id IN ${gone})`;
  return [
    db
      .prepare(
        `INSERT INTO reg_activity (campus_id, event_id, registration_id, actor_person_id, action, detail_json)
         SELECT r.campus_id, r.event_id, r.id, CAST(?2 AS INTEGER), 'logistics_released', NULL
         FROM registrations r WHERE r.id = ?1 AND (${guardSql})
           AND (${holds('reg_room_assignments')} OR ${holds('reg_table_seats')} OR ${holds('reg_group_members')})`,
      )
      .bind(id, actor),
    db.prepare(`DELETE FROM reg_room_assignments WHERE attendee_id IN ${gone} AND (${guardSql})`),
    db.prepare(`DELETE FROM reg_table_seats WHERE attendee_id IN ${gone} AND (${guardSql})`),
    db.prepare(`DELETE FROM reg_group_members WHERE attendee_id IN ${gone} AND (${guardSql})`),
    db.prepare(`UPDATE reg_rooms SET leader_attendee_id = NULL WHERE leader_attendee_id IN ${gone} AND (${guardSql})`),
    db.prepare(`UPDATE reg_tables SET host_attendee_id = NULL WHERE host_attendee_id IN ${gone} AND (${guardSql})`),
    db.prepare(`UPDATE reg_groups SET leader_attendee_id = NULL WHERE leader_attendee_id IN ${gone} AND (${guardSql})`),
  ];
}
