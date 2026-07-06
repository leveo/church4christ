// Pure scoring + content checks for the spiritual-gifts quiz. Verifies the
// normalized scoring corrects for uneven tag exposure, zeros/None are ignored,
// the top-3 + deduped recommendations are well-formed, and the bilingual data
// bank is complete (40 questions, 9 gifts, every gift 4–6 questions and mapped
// to ≥1 valid ministry category, en+zh present for every question and gift).
import { describe, expect, it } from 'vitest';
import {
  GIFTS,
  GIFT_CODES,
  QUESTIONS,
  giftMeta,
  scoreQuiz,
  type Answer,
} from '../src/lib/giftQuiz';
import { MINISTRY_CATEGORIES } from '../src/lib/ministryMeta';

const EXPECTED_CODES = [
  'teaching', 'service', 'mercy', 'giving', 'leadership',
  'hospitality', 'evangelism', 'encouragement', 'administration',
];

// How many questions tag each gift (its exposure).
const tagCount = (code: string) => QUESTIONS.filter((q) => q.tags.includes(code)).length;

describe('gift-questions data bank', () => {
  it('defines exactly the 9 expected gift codes', () => {
    expect([...GIFT_CODES].sort()).toEqual([...EXPECTED_CODES].sort());
    expect(GIFTS).toHaveLength(9);
  });

  it('has exactly 40 questions with ids 1..40', () => {
    expect(QUESTIONS).toHaveLength(40);
    expect(QUESTIONS.map((q) => q.id)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('tags every gift with 4–6 questions', () => {
    for (const code of GIFT_CODES) {
      const n = tagCount(code);
      expect(n, code).toBeGreaterThanOrEqual(4);
      expect(n, code).toBeLessThanOrEqual(6);
    }
  });

  it('tags exposure is uneven (so normalization matters)', () => {
    const counts = GIFT_CODES.map(tagCount);
    expect(Math.min(...counts)).toBeLessThan(Math.max(...counts));
  });

  it('maps every gift to ≥1 valid ministry category', () => {
    for (const g of GIFTS) {
      expect(g.ministries.length, g.code).toBeGreaterThanOrEqual(1);
      for (const m of g.ministries) expect(MINISTRY_CATEGORIES, `${g.code}:${m}`).toContain(m);
    }
  });

  it('every question tags only known gift codes', () => {
    for (const q of QUESTIONS) for (const tag of q.tags) expect(GIFT_CODES, `q${q.id}`).toContain(tag);
  });

  it('has non-empty en + zh copy for every question (zh in Simplified/CJK)', () => {
    for (const q of QUESTIONS) {
      expect(q.text.en.trim(), `q${q.id} en`).not.toBe('');
      expect(q.text.zh.trim(), `q${q.id} zh`).not.toBe('');
      expect(q.text.en, `q${q.id} en latin`).toMatch(/[A-Za-z]/);
      expect(q.text.zh, `q${q.id} zh cjk`).toMatch(/[一-鿿]/);
    }
  });

  it('has non-empty bilingual label + definition for every gift', () => {
    for (const g of GIFTS) {
      for (const loc of ['en', 'zh'] as const) {
        expect(g.label[loc].trim(), `${g.code} label ${loc}`).not.toBe('');
        expect(g.definition[loc].trim(), `${g.code} def ${loc}`).not.toBe('');
      }
      expect(g.label.zh, `${g.code} label zh cjk`).toMatch(/[一-鿿]/);
    }
  });
});

describe('scoreQuiz', () => {
  it('returns all 9 gifts, a top-3, and recommendations even for an empty submission', () => {
    const r = scoreQuiz({});
    expect(r.scores).toHaveLength(9);
    expect(r.scores.every((s) => s.raw === 0 && s.normalized === 0)).toBe(true);
    expect(r.topGifts).toHaveLength(3);
    // All-zero → canonical order breaks the ties.
    expect(r.topGifts).toEqual(GIFT_CODES.slice(0, 3));
  });

  it('ignores 0 ("Never") and undefined answers in the raw total', () => {
    const teaching = QUESTIONS.filter((q) => q.tags.length === 1 && q.tags[0] === 'teaching');
    const answers: Record<number, Answer> = {};
    for (const q of teaching) answers[q.id] = 0; // explicit Never
    const r = scoreQuiz(answers);
    expect(r.scores.find((s) => s.code === 'teaching')!.raw).toBe(0);
  });

  it('normalizes by exposure — a low-exposure gift can outrank a higher raw score', () => {
    // 4 of the 5 single-tag teaching questions → Always(3): raw 12, max 18.
    // All 3 single-tag giving questions → Always(3): raw 9, max 12.
    const answers: Record<number, Answer> = {};
    let tSet = 0;
    let gSet = 0;
    for (const q of QUESTIONS) {
      if (q.tags.length === 1 && q.tags[0] === 'teaching') answers[q.id] = (tSet++ < 4 ? 3 : 0) as Answer;
      else if (q.tags.length === 1 && q.tags[0] === 'giving') answers[q.id] = (gSet++ < 3 ? 3 : 0) as Answer;
    }
    const r = scoreQuiz(answers);
    const teaching = r.scores.find((s) => s.code === 'teaching')!;
    const giving = r.scores.find((s) => s.code === 'giving')!;
    expect(teaching.raw).toBeGreaterThan(giving.raw); // 12 > 9 on raw
    expect(giving.normalized).toBeGreaterThan(teaching.normalized); // 0.75 > 0.667 normalized
    // Sorted by normalized desc, giving comes before teaching.
    expect(r.scores.findIndex((s) => s.code === 'giving')).toBeLessThan(
      r.scores.findIndex((s) => s.code === 'teaching'),
    );
    expect(r.scores).toEqual([...r.scores].sort((a, b) => b.normalized - a.normalized));
  });

  it('derives a deterministic top-3 and deduped, order-preserving recommendations', () => {
    // Max out only the single-tag leadership / teaching / hospitality questions.
    const answers: Record<number, Answer> = {};
    for (const q of QUESTIONS) {
      if (q.tags.length === 1 && ['leadership', 'teaching', 'hospitality'].includes(q.tags[0])) answers[q.id] = 3;
    }
    const r = scoreQuiz(answers);
    // leadership (5/5 → 1.0) > teaching (5 of 6 → 0.833) > hospitality (4 of 5 → 0.8).
    expect(r.topGifts).toEqual(['leadership', 'teaching', 'hospitality']);

    // recommended = ordered dedup of the top-3 gifts' ministries.
    const expected: string[] = [];
    for (const code of r.topGifts) for (const m of giftMeta(code)!.ministries) if (!expected.includes(m)) expected.push(m);
    expect(r.recommended).toEqual(expected);
    // Dedup actually removed overlaps (youth/college/family recur across gifts).
    const rawUnion = r.topGifts.flatMap((c) => giftMeta(c)!.ministries);
    expect(r.recommended.length).toBeLessThan(rawUnion.length);
    for (const c of r.recommended) expect(MINISTRY_CATEGORIES).toContain(c);
  });
});
