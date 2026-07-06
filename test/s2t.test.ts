import { describe, it, expect } from 'vitest';
import { toTraditional } from '../src/lib/s2t';
import table from '../src/lib/s2t-table.json';

describe('s2t table', () => {
  it('loads and is non-empty', () => {
    expect(table.maxLen).toBeGreaterThanOrEqual(2);
    expect(Object.keys(table.map).length).toBeGreaterThan(1000);
  });
});

describe('toTraditional', () => {
  it('converts the church name', () => {
    expect(toTraditional('四方基督教会')).toBe('四方基督教會');
  });

  it('converts known pairs (per opencc-data first targets)', () => {
    expect(toTraditional('教会')).toBe('教會');
    expect(toTraditional('祷告')).toBe('禱告');
    expect(toTraditional('后来')).toBe('後來');
    // opencc-data STPhrases maps 台湾→臺灣 (臺, not 台) and 里面→裏面 (裏, not 裡).
    expect(toTraditional('台湾')).toBe('臺灣');
    expect(toTraditional('里面')).toBe('裏面');
  });

  it('uses phrase-level mappings where chars are ambiguous', () => {
    // 发 → 發 (emit) in isolation, but 髮 (hair) inside 头发.
    expect(toTraditional('头发')).toBe('頭髮');
    expect(toTraditional('发现')).toBe('發現');
  });

  it('greedy longest-match: protective identity phrases beat char-level conversion', () => {
    // Char-level 后→後, but the STPhrases identity entry 皇后→皇后 must win
    // (the empress is never 皇後); adjacent text still converts.
    expect(toTraditional('后')).toBe('後');
    expect(toTraditional('皇后')).toBe('皇后');
    expect(toTraditional('皇后来了')).toBe('皇后來了');
  });

  it('is idempotent', () => {
    for (const s of ['四方基督教会', '头发', '皇后来了', '台湾里面的教会祷告后来', 'Hello 世界 🙏']) {
      const once = toTraditional(s);
      expect(toTraditional(once)).toBe(once);
    }
  });

  it('leaves latin, digits, emoji, and empty strings untouched', () => {
    expect(toTraditional('Church4Christ 2026, TX')).toBe('Church4Christ 2026, TX');
    expect(toTraditional('🙏✝️😀')).toBe('🙏✝️😀');
    expect(toTraditional('')).toBe('');
  });
});
