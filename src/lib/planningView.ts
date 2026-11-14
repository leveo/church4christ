// Run-sheet view model shared by the member page, the coordinator editor, and the
// print view: items joined with computed times, owner names, and whether an item
// belongs to the viewing person.
import type { AppDb } from './appDb';
import type { Locale } from './db';
import { pickPair } from './locales';
import {
  getEvent,
  listItems,
  listPeopleByIds,
  listTeams,
  type PlanningEvent,
  type PlanningItem,
} from './planningDb';
import { computeRunSheet, type RunItemTiming, type RunSheetSummary } from './planningModel';

export interface RunSheetRow {
  item: PlanningItem;
  timing: RunItemTiming;
  title: string;
  details: string;
  owner: string;
  mine: boolean;
}

export interface RunSheetView {
  event: PlanningEvent;
  rows: RunSheetRow[];
  summary: RunSheetSummary;
}

export async function loadRunSheetView(
  db: AppDb,
  eventId: number,
  locale: Locale,
  viewer: { personId: number; teamIds: readonly number[] } | null,
): Promise<RunSheetView | null> {
  const event = await getEvent(db, eventId);
  if (!event) return null;
  const items = await listItems(db, eventId);
  const personIds = items.map((i) => i.owner_person_id).filter((id): id is number => id !== null);
  const [teams, people] = await Promise.all([listTeams(db, locale), listPeopleByIds(db, personIds)]);
  const teamName = new Map(teams.map((tm) => [tm.id, tm.name]));
  const personName = new Map(people.map((p) => [p.id, p.display_name]));
  const { rows: timings, summary } = computeRunSheet(event, items);
  const mineTeams = new Set(viewer?.teamIds ?? []);
  const rows = items.map((item, index) => ({
    item,
    timing: timings[index],
    title: pickPair(locale, item.title_en, item.title_zh),
    details: pickPair(locale, item.details_en, item.details_zh),
    owner: [
      item.owner_team_id !== null ? teamName.get(item.owner_team_id) : null,
      item.owner_person_id !== null ? personName.get(item.owner_person_id) : null,
      item.owner_label,
    ]
      .filter(Boolean)
      .join(' · '),
    mine:
      viewer !== null &&
      (item.owner_person_id === viewer.personId ||
        (item.owner_team_id !== null && mineTeams.has(item.owner_team_id))),
  }));
  return { event, rows, summary };
}
