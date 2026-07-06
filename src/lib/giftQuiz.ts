// Spiritual-gifts assessment: 40 first-person statements answered on a 4-point
// frequency scale (0 Never … 3 Always), each statement tagged to one or more of
// 9 gifts. Scoring sums the answer values per gift and NORMALIZES by that gift's
// maximum possible score — gifts are tagged by an uneven number of questions
// (4–6 here), so ranking on raw sums would bias toward the more-tagged gifts.
// The top-3 gifts drive a deduped list of recommended ministry categories.
//
// Data + original bilingual copy live in src/data/gift-questions.json.
import data from '../data/gift-questions.json';
import type { Locale } from './locales';

export interface GiftMeta {
  code: string;
  label: { en: string; zh: string };
  definition: { en: string; zh: string };
  /** Ministry categories (ministries.category vocabulary) this gift serves. */
  ministries: string[];
}

export interface GiftQuestion {
  id: number;
  tags: string[];
  text: { en: string; zh: string };
}

interface GiftData {
  gifts: GiftMeta[];
  questions: GiftQuestion[];
}

const DATA = data as GiftData;
export const GIFTS: readonly GiftMeta[] = DATA.gifts;
export const QUESTIONS: readonly GiftQuestion[] = DATA.questions;
export const GIFT_CODES: readonly string[] = DATA.gifts.map((g) => g.code);

/** 0 None/Never · 1 Sometimes · 2 Often · 3 Always. */
export type Answer = 0 | 1 | 2 | 3;

// How many questions tag each gift (its exposure). maxPossible = count * 3.
const TAG_COUNT: Record<string, number> = (() => {
  const m: Record<string, number> = Object.fromEntries(GIFT_CODES.map((c) => [c, 0]));
  for (const q of QUESTIONS) for (const tag of q.tags) if (tag in m) m[tag] += 1;
  return m;
})();

export interface GiftScore {
  code: string;
  /** Sum of the answer values (0–3) on every question tagging this gift. */
  raw: number;
  /** raw / (tagCount * 3): 0..1, comparable across unevenly-tagged gifts. */
  normalized: number;
}

export interface QuizResult {
  scores: GiftScore[];
  topGifts: string[];
  recommended: string[];
}

/**
 * Score a quiz. `answers` maps questionId → 0|1|2|3; a missing question or a 0
 * ("Never") contributes nothing to raw. Returns every gift sorted by normalized
 * score desc (ties broken by the canonical gift order), the top-3 gift codes,
 * and the deduped, order-preserving union of those gifts' recommended ministry
 * categories.
 */
export function scoreQuiz(answers: Record<number, Answer | undefined>): QuizResult {
  const raw: Record<string, number> = Object.fromEntries(GIFT_CODES.map((c) => [c, 0]));
  for (const q of QUESTIONS) {
    const v = answers[q.id];
    if (!v) continue; // undefined or 0 ("Never") ignored
    for (const tag of q.tags) if (tag in raw) raw[tag] += v;
  }
  const scores: GiftScore[] = DATA.gifts
    .map((g) => {
      const max = TAG_COUNT[g.code] * 3;
      return { code: g.code, raw: raw[g.code], normalized: max ? raw[g.code] / max : 0 };
    })
    .sort((a, b) => b.normalized - a.normalized || GIFT_CODES.indexOf(a.code) - GIFT_CODES.indexOf(b.code));

  const topGifts = scores.slice(0, 3).map((s) => s.code);
  const recommended: string[] = [];
  for (const code of topGifts) {
    const g = DATA.gifts.find((x) => x.code === code);
    if (!g) continue;
    for (const m of g.ministries) if (!recommended.includes(m)) recommended.push(m);
  }
  return { scores, topGifts, recommended };
}

/** Gift metadata by code (undefined for an unknown code). */
export function giftMeta(code: string): GiftMeta | undefined {
  return DATA.gifts.find((g) => g.code === code);
}

/** Localized label for a gift code, falling back to the raw code if unknown. */
export function giftLabel(code: string, locale: Locale): string {
  return giftMeta(code)?.label[locale] ?? code;
}
