// Registration lifecycle phase. Pure (no DB, no clock of its own) so the public
// list, the detail page, the submit endpoint and the admin badge all agree.
//
//   hidden  - not active, or its visible_from time has not arrived
//   preview - visible, but registration has not opened yet (opens_at in the future)
//   closed  - registration ended: now is at or past COALESCE(closes_at, starts_at)
//   open    - everything else (opens_at NULL = open as soon as it is visible)
//
// All timestamps are the app's UTC 'YYYY-MM-DD HH:MM:SS' text, so a lexical
// comparison is a chronological one (the same rule the SQL windows use).
import { toUtcSql } from './dates';

export type RegPhase = 'hidden' | 'preview' | 'open' | 'closed';

export interface RegPhaseInput {
  active: number;
  visible_from: string | null;
  opens_at: string | null;
  closes_at: string | null;
  starts_at: string;
}

/** Phase of an event at `now` (a Date or a UTC 'YYYY-MM-DD HH:MM:SS' string; default: the current time). */
export function eventPhase(event: RegPhaseInput, now: Date | string = new Date()): RegPhase {
  const at = typeof now === 'string' ? now : toUtcSql(now);
  if (event.active !== 1 || (event.visible_from !== null && at < event.visible_from)) return 'hidden';
  if (event.opens_at !== null && at < event.opens_at) return 'preview';
  if (at >= (event.closes_at ?? event.starts_at)) return 'closed';
  return 'open';
}
