// Pure view helpers for the event-logistics screens (event page tabs, prints, drawer): the class of a tag chip
// for each design-token color, and the dictionary key for each venue kind, capacity rule and room policy. Every
// lookup is an allowlist, so a stored value can only pick one of these.
import type { TagColor } from './regLogistics';
import type { CapacityRule, RoomPolicy, VenueKind } from './regHousing';

/** Tag chip classes, one per design-token color a tag may carry. */
export const TAG_CHIP: Record<TagColor, string> = {
  neutral: 'bg-surface-sunken text-ink-muted',
  primary: 'bg-primary-soft text-on-primary-soft',
  accent: 'bg-accent-soft text-on-accent-soft',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
};

export const tagColorKey = (color: TagColor): string => `admin.reg.lx.color.${color}`;
export const venueKindKey = (kind: VenueKind): string => `admin.reg.lx.kind.${kind}`;
export const capacityRuleKey = (rule: CapacityRule): string => `admin.reg.lx.rule.${rule}`;
export const roomPolicyKey = (policy: RoomPolicy): string => `admin.reg.lx.policy.${policy}`;

/** "Room 204 (Pine Lodge)"-style text pieces are assembled by the caller; this joins a label and a venue. */
export const roomWithVenue = (label: string, venue: string): string => (venue ? `${label} (${venue})` : label);
