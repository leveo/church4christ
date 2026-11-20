// The page-builder `registration` card: one registration event as a poster card with its date,
// place, a phase-aware state line and a button to the sign-up page. The view model and the HTML
// are pure (unit-tested without a database); loadRegistrationCard reads the event through the
// same public readers as /register, so a hidden event, a template or an unknown id renders nothing.
import type { AppDb } from './appDb';
import type { L10nString, RegistrationNode } from './pageLayout';
import { pickLocalizedText, localePath, type Locale } from './locales';
import { formatDate, utcToDatetimeLocal } from './dates';
import { getPublicEvent, listTicketTypes, type RegPublicEvent, type RegTicketType } from './regDb';
import { seatsLeft, seatState } from './regPublic';
import { buttonRender } from './blockStyles';
import { mediaPath } from './mediaRef';
import { esc } from './regViewHtml';

export type RegCardState = 'preview' | 'open' | 'full' | 'waitlist' | 'closed';

export interface RegCardView {
  title: string;
  poster: string | null;
  /** Church-local start, as the register pages show it. */
  startsAt: string;
  location: string | null;
  state: RegCardState;
  /** Church-local opening time (preview only). */
  opensAt: string | null;
  /** Seats left while the event is open and not full; null = unlimited or not asked for. */
  seats: number | null;
  href: string;
}

/** The card's copy, already localized. */
export interface RegCardCopy {
  cta: string;
  /** Button text while registration has not opened yet (Preview). */
  details: string;
  opensOn: (date: string) => string;
  seatsLeft: (count: number) => string;
  full: string;
  fullWaitlist: string;
  closed: string;
}

const stamp = (utc: string, locale: Locale): string => {
  const [date, time] = utcToDatetimeLocal(utc).split('T');
  return `${formatDate(date, locale)} ${time}`;
};

export function registrationCardView(
  event: RegPublicEvent,
  activeTypes: readonly RegTicketType[],
  locale: Locale,
  showSeats: boolean,
): RegCardView {
  const fullness = seatState(event, activeTypes);
  const state: RegCardState =
    event.phase === 'preview' ? 'preview'
    : event.phase === 'closed' ? 'closed'
    : fullness.waitlist ? 'waitlist'
    : fullness.full ? 'full'
    : 'open';
  const left = state === 'open' && showSeats ? seatsLeft(event, activeTypes) : null;
  return {
    title: event.title,
    poster: mediaPath(event.poster),
    startsAt: stamp(event.starts_at, locale),
    location: event.location,
    state,
    opensAt: state === 'preview' && event.opens_at ? stamp(event.opens_at, locale) : null,
    seats: left,
    href: localePath(locale, `/register/${event.id}`),
  };
}

/** The card's HTML. Every dynamic value is escaped; classes are design tokens only. */
export function registrationCardHtml(view: RegCardView, copy: RegCardCopy, buttonLabel: string): string {
  const stateLine =
    view.state === 'preview' && view.opensAt ? copy.opensOn(view.opensAt)
    : view.state === 'open' && view.seats !== null ? copy.seatsLeft(view.seats)
    : view.state === 'waitlist' ? copy.fullWaitlist
    : view.state === 'full' ? copy.full
    : view.state === 'closed' ? copy.closed
    : '';
  const tone = view.state === 'open' || view.state === 'preview' ? 'text-primary' : 'text-ink-muted';
  // Before registration opens the button only leads to the details, so it never says "Register".
  const label = view.state === 'preview' ? copy.details : buttonLabel || copy.cta;
  const link = buttonRender({ label: { en: '', zh: '' }, href: '', variant: view.state === 'closed' || view.state === 'full' ? 'secondary' : 'primary', align: 'left' }).linkClass;
  return `<article class="registration-block overflow-hidden rounded-lg border border-border bg-surface-raised" data-reg-state="${view.state}">`
    + (view.poster ? `<img src="${esc(view.poster)}" alt="" loading="lazy" class="aspect-video w-full object-cover">` : '')
    + `<div class="space-y-2 p-5">`
    + `<h3 class="font-display text-lg font-bold">${esc(view.title)}</h3>`
    + `<p class="text-sm text-ink-muted">${esc(view.startsAt)}</p>`
    + (view.location ? `<p class="text-sm text-ink-muted">${esc(view.location)}</p>` : '')
    + (stateLine ? `<p class="text-sm font-semibold ${tone}">${esc(stateLine)}</p>` : '')
    + (view.state === 'closed' ? '' : `<div class="pt-2"><a href="${esc(view.href)}" class="${link}">${esc(label)}</a></div>`)
    + `</div></article>`;
}

/** Load one event for the card: null for an unknown, hidden or template event. */
export async function loadRegistrationCard(
  db: AppDb,
  locale: Locale,
  props: RegistrationNode['props'],
  copy: RegCardCopy,
): Promise<string> {
  if (props.eventId === null) return '';
  const event = await getPublicEvent(db, locale, props.eventId);
  if (!event || event.phase === 'hidden') return '';
  const types = await listTicketTypes(db, locale, event.id, { activeOnly: true });
  const label = pickLocalizedText(props.buttonLabel as L10nString, locale);
  return registrationCardHtml(registrationCardView(event, types, locale, props.showSeats), copy, label);
}
