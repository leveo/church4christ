import { describe, expect, it } from 'vitest';
import opportunityPage from '../src/pages/[locale]/my/opportunities.astro?raw';
import managePage from '../src/pages/[locale]/manage/index.astro?raw';
import ministryManagePage from '../src/pages/[locale]/manage/ministries/[id].astro?raw';
import { memberNavigation } from '../src/lib/memberNavigation';
import portalDashboard from '../src/pages/[locale]/my/index.astro?raw';
import authTokenPage from '../src/pages/auth/[token].astro?raw';
import deployGuide from '../docs/deploy.md?raw';
import portalGuide from '../docs/features/member-portal.md?raw';

describe('member opportunity landing page', () => {
  it('aggregates only enabled group, learning, and serving sources', () => {
    expect(opportunityPage).toContain('buildMemberOpportunityCatalog');
    expect(opportunityPage).toContain("modules.has('groups')");
    expect(opportunityPage).toContain("modules.has('learning')");
    expect(opportunityPage).toContain("modules.has('serve')");
    expect(opportunityPage).toContain('listPendingJoinGroupIdsForPerson');
  });

  it('is discoverable as a portal tab and exposes manager actions outside /admin', () => {
    expect(memberNavigation(new Set(['portal']), 'en')).toContainEqual(expect.objectContaining({
      key: 'opportunities', href: '/en/my/opportunities',
    }));
    expect(portalDashboard).toContain("'/my/opportunities'");
    expect(opportunityPage).toContain("'/manage'");
    expect(opportunityPage).not.toMatch(/href=.*\/admin/);
  });

  it('is the default post-sign-in landing page when the portal is enabled', () => {
    expect(authTokenPage).toContain("modules.has('portal') ? 'my/opportunities'");
  });

  it('documents opportunity aggregation and the application-authenticated leader panel', () => {
    expect(portalGuide).toContain('/my/opportunities');
    expect(portalGuide).toContain('/{locale}/manage');
    expect(portalGuide).toContain('Learning');
  });
});

describe('application-authenticated leader management', () => {
  it('documents that the optional Zero Trust policy covers /admin, not leader routes', () => {
    expect(deployGuide).toContain('/{locale}/manage');
    expect(deployGuide).toContain('application-level authorization');
  });

  it('collects only resources led by the signed-in person', () => {
    expect(managePage).toContain('listGroupsForPerson');
    expect(managePage).toContain('is_admin === 1');
    expect(managePage).toContain('leaderMinistryIds');
    expect(managePage).toContain('leaderTeamIds');
    expect(managePage).not.toMatch(/href=.*\/admin/);
  });

  it('rechecks ministry ownership on GET and POST and preserves leader assignment', () => {
    expect(ministryManagePage).toContain('canManageMinistry');
    expect(ministryManagePage).toContain("Astro.request.method === 'POST'");
    expect(ministryManagePage).toContain('leader_person_id: ministry.leader_person_id');
    expect(ministryManagePage).toContain('updateMinistryBasics');
    expect(ministryManagePage).not.toMatch(/href=.*\/admin/);
  });
});
