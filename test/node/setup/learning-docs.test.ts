import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const feature = read('docs/features/learning.md');
const modules = read('docs/features/modules.md');
const readme = read('README.md');

function png(path: string): { readonly width: number; readonly height: number; readonly bytes: number; readonly sha256: string } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('Learning module introduction documentation', () => {
  it('preserves and embeds the exact gpt-image-2 workflow diagram with useful provenance', () => {
    expect(png('docs/images/learning/learning-flow-gpt-image-2.png')).toEqual({
      width: 2048,
      height: 1152,
      bytes: 2_037_983,
      sha256: '876a2adf737721297383ceaf8d15c223e9c937814d4fbb543b502c55ea377356',
    });
    expect(feature).toContain('../images/learning/learning-flow-gpt-image-2.png');
    expect(feature).toMatch(/alt text[^\n]*(Google Classroom|provider)[^\n]*Canvas/i);
    expect(feature).toMatch(/gpt-image-2/i);
    expect(feature).toMatch(/2026-08-18/);
    expect(feature).toMatch(/prompt summary/i);
    expect(feature).toContain('876a2adf737721297383ceaf8d15c223e9c937814d4fbb543b502c55ea377356');
  });

  it('embeds complete real Genesis learner and admin screenshots at the release viewport', () => {
    for (const path of [
      'docs/images/learning/genesis-1-en.png',
      'docs/images/learning/genesis-1-zh.png',
      'docs/images/learning/admin-overview.png',
    ]) {
      const image = png(path);
      expect(image.width, path).toBe(1280);
      expect(image.height, path).toBe(800);
      expect(image.bytes, path).toBeGreaterThan(20 * 1024);
    }
    expect(feature).toContain('../images/learning/genesis-1-en.png');
    expect(feature).toContain('../images/learning/genesis-1-zh.png');
    expect(feature).toContain('../images/learning/admin-overview.png');
    expect(feature).toMatch(/Sarah Johnson[^\n]*English/i);
    expect(feature).toMatch(/Grace Lin[^\n]*(Chinese|中文)/i);
    expect(feature).toMatch(/fictional local Canvas snapshot/i);
    expect(feature).toContain('.example.test');
  });

  it('explains the provider-authoritative workflow, privacy boundary, and Canvas credit', () => {
    expect(feature).toMatch(/Sunday school/i);
    expect(feature).toMatch(/discipleship/i);
    expect(feature).toMatch(/YouTube[^\n]*(unlisted|privacy-enhanced)/i);
    expect(feature).toMatch(/provider[^\n]*authoritative/i);
    expect(feature).toMatch(/assignments?[^\n]*quizzes?[^\n]*(provider|Google Classroom|Canvas)/i);
    expect(feature).toMatch(/grades[^\n]*(not|never|excluded)/i);
    expect(feature).toMatch(/answers[^\n]*(not|never|excluded)/i);
    expect(feature).toMatch(/manual sync/i);
    expect(feature).toMatch(/scheduled/i);
    expect(feature).toMatch(/Activity Score[^\n]*(optional|disabled)/i);
    expect(feature).toContain('https://github.com/instructure/canvas-lms');
    expect(feature).toContain('1c9f0bb8013ed69c4f2efe11fd483025469b7e6c');
    expect(feature).toMatch(/Instructure, Inc\./);
    expect(feature).toMatch(/AGPL v3/i);
    expect(feature).toMatch(/not affiliated[^\n]*(sponsored|endorsed)/i);
    expect(feature).toMatch(/separate (repository|checkout|deployment)/i);
  });

  it('links the canonical introduction from README and the module index', () => {
    expect(readme).toMatch(/Learning[^\n]*docs\/features\/learning\.md/i);
    expect(readme).toContain('docs/images/learning/genesis-1-en.png');
    expect(modules).toMatch(/`learning`[^\n]*\[Learning\]\(learning\.md\)/);
  });

  it('requires one ephemeral screenshot secret in both local processes without persisting it', () => {
    const harness = read('scripts/screenshots.mjs');
    expect(feature).toMatch(/dev-server shell[\s\S]*SCREENSHOT_SESSION_SECRET[\s\S]*npm run dev/i);
    expect(feature).toMatch(/capture shell[\s\S]*same SCREENSHOT_SESSION_SECRET[\s\S]*npm run screenshots/i);
    expect(feature).toMatch(/distinct from[^\n]*SESSION_SECRET/i);
    expect(harness).toMatch(/same ephemeral SCREENSHOT_SESSION_SECRET[^\n]*both[^\n]*processes/i);
    expect(harness).not.toMatch(/SCREENSHOT_SESSION_SECRET[^\n]*match[^\n]*SESSION_SECRET/i);
    expect(harness).not.toContain("SCREENSHOT_SESSION_SECRET='<same local SESSION_SECRET>'");
  });

  it('distinguishes setup demo gating from the direct local screenshot seed command', () => {
    expect(feature).toMatch(/setup[^\n]*--demo-data/i);
    expect(feature).toMatch(/screenshot runbook[^\n]*(directly|deliberately)[^\n]*(dev-seed|same seed)/i);
    expect(feature).not.toMatch(/Genesis fixture is loaded only by[^\n]*--demo-data/i);
  });
});
