import { describe, expect, it } from 'vitest';
import header from '../src/components/Header.astro?raw';
import readme from '../README.md?raw';

describe('grouped public header', () => {
  it('renders compact desktop disclosures and labeled mobile groups from one grouped model', () => {
    expect(header).toContain('groupNavLinks');
    expect(header).toContain('groups.map');
    expect(header).toContain('<details');
    expect(header).toContain('<summary');
    expect(header).toContain('group.links.map');
    expect(header).not.toMatch(/\n\s+links\.map/u);
  });

  it('documents the grouped navigation and updated member opportunity workflow', () => {
    expect(readme).toContain('Grouped navigation');
    expect(readme).toContain('member-opportunity-workflow.png');
    expect(readme).toContain('member-opportunities.png');
    expect(readme).toContain('leader-panel.png');
  });
});
