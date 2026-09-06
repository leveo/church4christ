// Thin 'astro:content' wrapper over the pure core in ./contentCore. Fetches a
// collection then delegates locale resolution to the tested core. Pages import
// getLocalized/listLocalized from here and render entries with astro:content's
// render().
import { getCollection } from 'astro:content';
import type { CollectionEntry, CollectionKey } from 'astro:content';
import type { Locale } from './locales';
import type { AppDb } from './appDb';
import { getLocalizedFrom, listLocalizedFrom, slugOf } from './contentCore';
import { includeDemoContent } from './contentVisibility';

export { slugOf };

/** Resolve one slug in `coll` for `locale`, with en-fallback + translated flag. */
export async function getLocalized<C extends CollectionKey>(
  coll: C,
  slug: string,
  locale: Locale,
  db: AppDb,
): Promise<{ entry: CollectionEntry<C>; translated: boolean } | null> {
  const entries = (await getCollection(coll)) as CollectionEntry<C>[];
  return getLocalizedFrom(entries, slug, locale, await includeDemoContent(db));
}

/** Deduped list of every slug in `coll` for `locale`, preferring localized entries. */
export async function listLocalized<C extends CollectionKey>(
  coll: C,
  locale: Locale,
  db: AppDb,
): Promise<{ entry: CollectionEntry<C>; translated: boolean; slug: string }[]> {
  const entries = (await getCollection(coll)) as CollectionEntry<C>[];
  return listLocalizedFrom(entries, locale, await includeDemoContent(db));
}
