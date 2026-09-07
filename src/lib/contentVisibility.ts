import type { AppDb } from './appDb';
import { getSetting } from './settings';

/** Read through the request's campus-scoped DB; an absent key keeps legacy sites intact. */
export async function includeDemoContent(db: AppDb): Promise<boolean> {
  return (await getSetting(db, 'site.demo_content', 'true')) !== 'false';
}
