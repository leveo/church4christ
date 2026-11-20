// Pure view helpers for the registration event page: which dictionary key says what for a notice, a refusal, a
// soft-confirm reason, a history row. Every lookup is an allowlist, so a query-string value can only ever pick one of
// these keys; anything else shows nothing (notice) or the generic message (refusal).
import { formatCents } from './money';
import type { ActivityEntry } from './regAdmin';

const NOTICES: Record<string, string> = {
  saved: 'admin.reg.bo.n.saved',
  person_added: 'admin.reg.bo.n.personAdded',
  person_removed: 'admin.reg.bo.n.personRemoved',
  cancelled: 'admin.reg.cancelled',
  moved: 'admin.reg.bo.n.moved',
  decided_accept: 'admin.reg.bo.n.accepted',
  decided_waitlist: 'admin.reg.bo.n.waitlisted',
  decided_decline: 'admin.reg.bo.n.declined',
  resent: 'admin.reg.bo.n.resent',
  created: 'admin.reg.bo.n.created',
  bulk_queued: 'admin.reg.bo.n.bulkQueued',
  refunded: 'admin.reg.bo.n.refunded',
  refund_recorded: 'admin.reg.bo.n.refundRecorded',
  role_granted: 'admin.reg.bo.n.roleGranted',
  role_revoked: 'admin.reg.bo.n.roleRevoked',
  conflict: 'admin.reg.bo.n.conflict',
  // Event logistics ({n} and {m} come from the redirect's n= and m=).
  lx_saved: 'admin.reg.bo.n.saved',
  lx_deleted: 'admin.reg.lx.n.deleted',
  lx_rooms_added: 'admin.reg.lx.n.roomsAdded',
  lx_rooms_confirmed: 'admin.reg.lx.n.roomsConfirmed',
  lx_rooms_unconfirmed: 'admin.reg.lx.n.roomsUnconfirmed',
  lx_rooms_deleted: 'admin.reg.lx.n.roomsDeleted',
  lx_assigned: 'admin.reg.lx.n.assigned',
  lx_removed: 'admin.reg.lx.n.removed',
  lx_cleared: 'admin.reg.lx.n.cleared',
  lx_swapped: 'admin.reg.lx.n.swapped',
  lx_tables_added: 'admin.reg.lx.n.tablesAdded',
  lx_tables_deleted: 'admin.reg.lx.n.tablesDeleted',
  lx_seated: 'admin.reg.lx.n.seated',
  lx_seat_applied: 'admin.reg.lx.n.seatApplied',
  lx_group_filled: 'admin.reg.lx.n.groupFilled',
  lx_tagged: 'admin.reg.lx.n.tagged',
  lx_untagged: 'admin.reg.lx.n.untagged',
};

/** The dictionary key for a `?notice=` value (null for anything unknown, so nothing is shown). */
export const noticeKey = (notice: string | null | undefined): string | null => (notice ? (NOTICES[notice] ?? null) : null);

const FAILURES: Record<string, string> = {
  not_editable: 'admin.reg.bo.e.notEditable',
  paid_registration: 'admin.reg.bo.e.paidRegistration',
  ticket_type_invalid: 'register.err.ticketInvalid',
  party_too_large: 'register.err.tooMany',
  invalid: 'register.error.invalid',
  not_found: 'register.manage.notAllowed',
  resend_failed: 'admin.reg.bo.e.resendFailed',
  invalid_amount: 'admin.reg.bo.e.invalidAmount',
  exceeds_paid: 'admin.reg.bo.e.exceedsPaid',
  not_stripe: 'admin.reg.bo.e.notStripe',
  use_stripe: 'admin.reg.bo.e.notStripe',
  no_payment: 'admin.reg.bo.e.noPayment',
  no_payment_intent: 'admin.reg.bo.e.noPaymentIntent',
  refund_failed: 'admin.reg.bo.e.refundFailed',
  unavailable: 'admin.reg.bo.e.refundUnavailable',
  payment_method_required: 'admin.reg.bo.e.paymentMethodRequired',
  approval_requires_free: 'admin.reg.bo.e.approvalFree',
  no_recipients: 'admin.reg.bo.e.noRecipients',
  too_many: 'admin.reg.bo.e.tooManyRecipients',
  person_not_found: 'register.manage.notAllowed',
  event_not_found: 'register.manage.notAllowed',
  invalid_role: 'register.manage.notAllowed',
  // Event logistics (regLogisticsPage.ts namespaces every refusal as lx_<code>).
  lx_disabled: 'admin.reg.lx.e.disabled',
  lx_not_found: 'admin.reg.lx.e.notFound',
  lx_invalid: 'admin.reg.lx.e.invalid',
  lx_duplicate: 'admin.reg.lx.e.duplicate',
  lx_conflict: 'admin.reg.lx.e.conflict',
  lx_stale_seating: 'admin.reg.lx.e.staleSeating',
  lx_stale_groups: 'admin.reg.lx.e.staleGroups',
  lx_not_active: 'admin.reg.lx.e.notActive',
  lx_not_eligible: 'admin.reg.lx.e.notEligible',
  lx_ROOM_FULL: 'admin.reg.lx.e.roomFull',
  lx_room_unconfirmed: 'admin.reg.lx.e.roomUnconfirmed',
  lx_venue_occupied: 'admin.reg.lx.e.venueOccupied',
  lx_in_use: 'admin.reg.lx.e.inUse',
  lx_not_occupant: 'admin.reg.lx.e.notOccupant',
  lx_not_seated: 'admin.reg.lx.e.notSeated',
  lx_group_not_empty: 'admin.reg.lx.e.groupNotEmpty',
  lx_not_member: 'admin.reg.lx.e.notMember',
  lx_too_many: 'admin.reg.lx.e.tooMany',
  lx_labels_empty: 'admin.reg.lx.e.labelsEmpty',
  lx_labels_too_many: 'admin.reg.lx.e.labelsTooMany',
  lx_labels_reversed: 'admin.reg.lx.e.labelsReversed',
  lx_labels_bad_range: 'admin.reg.lx.e.labelsBadRange',
  lx_labels_too_long: 'admin.reg.lx.e.labelsTooLong',
  lx_beds_required: 'admin.reg.lx.e.bedsRequired',
  lx_question: 'admin.reg.lx.e.question',
  lx_rules: 'admin.reg.lx.e.rules',
  lx_none_selected: 'admin.reg.lx.e.noneSelected',
  lx_no_person: 'admin.reg.lx.e.noPerson',
  lx_no_target: 'admin.reg.lx.e.noTarget',
  lx_no_tag: 'admin.reg.lx.e.noTag',
};

/** The dictionary key for a refused action's code (an unknown logistics code gets the logistics catch-all). */
export const failureKey = (code: string): string => FAILURES[code] ?? (code.startsWith('lx_') ? 'admin.reg.lx.e.invalid' : 'register.manage.failed');

const REASONS: Record<string, string> = {
  event_full: 'admin.reg.bo.confirmEventFull',
  ticket_type_full: 'admin.reg.bo.confirmTypeFull',
  capacity: 'admin.reg.bo.confirmCapacity',
  // Event logistics soft rules.
  room_over_capacity: 'admin.reg.lx.c.roomOverCapacity',
  room_other_party: 'admin.reg.lx.c.roomOtherParty',
  room_mixed_gender: 'admin.reg.lx.c.roomMixedGender',
  gender_unknown: 'admin.reg.lx.c.genderUnknown',
  gender_question_missing: 'admin.reg.lx.c.genderQuestionMissing',
  table_full: 'admin.reg.lx.c.tableFull',
  party_split: 'admin.reg.lx.c.partySplit',
  group_full: 'admin.reg.lx.c.groupFull',
};

/** The dictionary key for a soft-confirm reason. */
export const reasonKey = (reason: string): string => REASONS[reason] ?? REASONS.capacity;

const ACTIVITY: Record<string, string> = {
  created: 'admin.reg.act.created',
  edit: 'admin.reg.act.edit',
  note: 'admin.reg.act.note',
  ticket_type: 'admin.reg.act.ticketType',
  person_added: 'admin.reg.act.personAdded',
  person_removed: 'admin.reg.act.personRemoved',
  cancelled: 'admin.reg.act.cancelled',
  moved: 'admin.reg.act.moved',
  accepted: 'admin.reg.act.accepted',
  waitlisted: 'admin.reg.act.waitlisted',
  declined: 'admin.reg.act.declined',
  checkin: 'admin.reg.act.checkin',
  checkin_undo: 'admin.reg.act.checkinUndo',
  checkout: 'admin.reg.act.checkout',
  checkin_party: 'admin.reg.act.checkinParty',
  refund: 'admin.reg.act.refund',
  bulk_email: 'admin.reg.act.bulkEmail',
  resent: 'admin.reg.act.resent',
  // Event logistics.
  room_assigned: 'admin.reg.act.roomAssigned',
  room_moved: 'admin.reg.act.roomMoved',
  room_unassigned: 'admin.reg.act.roomUnassigned',
  room_swapped: 'admin.reg.act.roomSwapped',
  room_leader: 'admin.reg.act.roomLeader',
  room_leader_cleared: 'admin.reg.act.roomLeaderCleared',
  table_seated: 'admin.reg.act.tableSeated',
  table_moved: 'admin.reg.act.tableMoved',
  table_unseated: 'admin.reg.act.tableUnseated',
  table_host: 'admin.reg.act.tableHost',
  table_host_cleared: 'admin.reg.act.tableHostCleared',
  table_auto_seated: 'admin.reg.act.tableAutoSeated',
  group_joined: 'admin.reg.act.groupJoined',
  group_left: 'admin.reg.act.groupLeft',
  group_leader: 'admin.reg.act.groupLeader',
  group_leader_cleared: 'admin.reg.act.groupLeaderCleared',
  group_auto_filled: 'admin.reg.act.groupAutoFilled',
  tagged: 'admin.reg.act.tagged',
  untagged: 'admin.reg.act.untagged',
  logistics_released: 'admin.reg.act.logisticsReleased',
};

/** The dictionary key naming one history action (unknown actions fall back to a generic label). */
export const activityKey = (action: string): string => ACTIVITY[action] ?? 'admin.reg.act.other';

/** A short, safe, language-neutral extra for a history row (amounts, the bulk subject, the status it came from), or ''. */
export function activityDetailText(entry: Pick<ActivityEntry, 'action' | 'detail'>, currency: string, statusLabel: (status: string) => string): string {
  const d = entry.detail;
  if (!d) return '';
  const status = (value: unknown): string => (typeof value === 'string' ? statusLabel(value) : '');
  switch (entry.action) {
    case 'refund':
      return typeof d.cents === 'number' ? formatCents(d.cents, currency) : '';
    case 'bulk_email':
      return typeof d.subject === 'string' ? d.subject : '';
    case 'moved':
      return d.from && d.to ? `${status(d.from)} → ${status(d.to)}` : '';
    case 'cancelled':
    case 'accepted':
    case 'waitlisted':
    case 'declined':
      return d.from ? status(d.from) : '';
    case 'edit':
      return Array.isArray(d.fields) ? d.fields.filter((f): f is string => typeof f === 'string').join(', ') : '';
    // Event logistics: the room / table / group / tag label staff typed, and the reason given for a move.
    case 'room_assigned':
    case 'room_moved':
      return withReason(typeof d.room === 'string' ? `${d.room}${typeof d.venue === 'string' && d.venue ? ` (${d.venue})` : ''}` : '', d.reason);
    case 'room_unassigned':
    case 'room_leader':
    case 'room_leader_cleared':
      return withReason(typeof d.room === 'string' ? d.room : '', d.reason);
    case 'room_swapped':
      return withReason(Array.isArray(d.rooms) ? d.rooms.filter((r): r is string => typeof r === 'string').join(' ↔ ') : '', d.reason);
    case 'table_seated':
    case 'table_moved':
    case 'table_host':
    case 'table_host_cleared':
      return typeof d.table === 'string' ? d.table : '';
    case 'group_joined':
    case 'group_leader':
    case 'group_leader_cleared':
      return typeof d.group === 'string' ? d.group : '';
    case 'tagged':
    case 'untagged':
      return typeof d.tag === 'string' ? d.tag : '';
    default:
      return '';
  }
}

/** "label · reason" (either may be missing). */
function withReason(label: string, reason: unknown): string {
  const why = typeof reason === 'string' ? reason : '';
  return [label, why].filter(Boolean).join(' · ');
}
