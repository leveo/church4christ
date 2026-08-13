import { describe, expect, it } from 'vitest';
import publicSource from '../../../src/pages/[locale]/new-here.astro?raw';
import queueSource from '../../../src/pages/admin/newcomers/index.astro?raw';
import newSource from '../../../src/pages/admin/newcomers/new.astro?raw';
import detailSource from '../../../src/pages/admin/newcomers/[id].astro?raw';
import settingsSource from '../../../src/pages/admin/newcomers/settings.astro?raw';

describe('Newcomer route source boundaries', () => {
  it('uses the bounded reader, trusted CF IP, generic public outcome, and no People writes', () => {
    expect(publicSource).toContain('readNewcomerUrlencodedForm');
    expect(publicSource).toContain("headers.get('CF-Connecting-IP')");
    expect(publicSource).not.toContain('X-Forwarded-For');
    expect(publicSource).toContain('consumeNewcomerPublicRateLimit');
    expect(publicSource).toContain('createNewcomerSubmission');
    expect(publicSource).not.toMatch(/INSERT INTO people|createNewcomerVisitor|linkNewcomerPerson/);
    expect(publicSource).toContain("headers.set('Cache-Control', 'no-store')");
  });

  it('keeps scoped staff routes module/area gated and settings super-only', () => {
    for (const source of [queueSource, newSource, detailSource, settingsSource]) {
      expect(source).toContain("modules.has('newcomers')");
    }
    expect(queueSource).toContain("hasAreaAccess(user, 'newcomers')");
    expect(newSource).toContain("hasAreaAccess(user, 'newcomers')");
    expect(detailSource).toContain("hasAreaAccess(user, 'newcomers')");
    expect(settingsSource).toContain('user?.isSuperAdmin');
  });

  it('uses CAS DB actions, exact duplicate hints, and full-People visitor gating', () => {
    for (const action of ['assignNewcomer', 'changeNewcomerStatus', 'scheduleNewcomerFollowUp', 'addNewcomerNote']) {
      expect(detailSource).toContain(action);
    }
    expect(detailSource).toContain('findNewcomerDuplicateHints');
    expect(detailSource).toContain('listNewcomerStaffStatuses');
    expect(detailSource).not.toContain('[1,2,3,4,5]');
    expect(detailSource).toContain("hint.kind === 'person_live'");
    expect(detailSource).toContain("modules.has('people') && hasAreaAccess(user, 'people')");
    expect(detailSource).toContain('createNewcomerVisitor');
    expect(detailSource).toContain('linkNewcomerPerson');
    expect(detailSource).not.toMatch(/set:html|innerHTML|outerHTML/);
  });
});
