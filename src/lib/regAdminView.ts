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
};

/** The dictionary key for a refused action's code. */
export const failureKey = (code: string): string => FAILURES[code] ?? 'register.manage.failed';

const REASONS: Record<string, string> = {
  event_full: 'admin.reg.bo.confirmEventFull',
  ticket_type_full: 'admin.reg.bo.confirmTypeFull',
  capacity: 'admin.reg.bo.confirmCapacity',
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
    default:
      return '';
  }
}
