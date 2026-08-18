import { describe, expect, it } from 'vitest';
import { formatLearningDateTime } from '../src/lib/learningLearnerUi';

describe('Learning learner UI formatting', () => {
  it('renders provider timestamps in the church timezone with an honest zone label', () => {
    const rendered = formatLearningDateTime('2026-08-17T12:00:00.000Z', 'en');
    expect(rendered).toContain('7:00 AM');
    expect(rendered).toMatch(/(?:CDT|GMT-5)/u);
    expect(rendered).not.toContain('12:00 PM');
  });
});
