export type MemberOpportunityKind = 'sunday_school' | 'group' | 'course' | 'team';
export type MemberOpportunityState = 'joined' | 'enrolled' | 'leader' | 'pending' | 'approved' | 'open';

export interface MemberOpportunityItem {
  kind: MemberOpportunityKind;
  id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  positions: string[];
  state: MemberOpportunityState;
  isManager: boolean;
}

interface GroupInput {
  id: number;
  name: string;
  description: string;
  kind: 'fellowship' | 'sunday_school';
}

interface GroupMembershipInput extends GroupInput {
  is_admin: number;
}

interface CourseInput {
  courseId: number;
  displayName: string;
  programName: string;
}

interface ApplicationTeamInput {
  team_id: number;
  team_name: string;
  ministry_name: string | null;
  positions: string[];
}

interface TeamMembershipInput {
  team_id: number;
  name: string;
  is_leader: number;
}

interface ApplicationInput {
  team_id: number;
  team_name: string;
  position_name: string | null;
  status: 'P' | 'A' | 'R';
}

export interface MemberOpportunityCatalogInput {
  modules: ReadonlySet<string>;
  publicGroups: readonly GroupInput[];
  groupMemberships: readonly GroupMembershipInput[];
  pendingGroupIds: readonly number[];
  courses: readonly CourseInput[];
  applicationTeams: readonly ApplicationTeamInput[];
  teamMemberships: readonly TeamMembershipInput[];
  applications: readonly ApplicationInput[];
}

export interface MemberOpportunityCatalog {
  current: MemberOpportunityItem[];
  open: MemberOpportunityItem[];
}

const groupKind = (kind: GroupInput['kind']): MemberOpportunityKind =>
  kind === 'sunday_school' ? 'sunday_school' : 'group';

export function buildMemberOpportunityCatalog(input: MemberOpportunityCatalogInput): MemberOpportunityCatalog {
  if (!input.modules.has('portal')) return { current: [], open: [] };

  const current: MemberOpportunityItem[] = [];
  const open: MemberOpportunityItem[] = [];

  if (input.modules.has('groups')) {
    const memberIds = new Set(input.groupMemberships.map(({ id }) => id));
    const pendingIds = new Set(input.pendingGroupIds);

    for (const group of input.groupMemberships) {
      current.push({
        kind: groupKind(group.kind),
        id: group.id,
        title: group.name,
        subtitle: null,
        description: group.description || null,
        positions: [],
        state: 'joined',
        isManager: group.is_admin === 1,
      });
    }
    for (const group of input.publicGroups) {
      if (memberIds.has(group.id)) continue;
      const item: MemberOpportunityItem = {
        kind: groupKind(group.kind),
        id: group.id,
        title: group.name,
        subtitle: null,
        description: group.description || null,
        positions: [],
        state: pendingIds.has(group.id) ? 'pending' : 'open',
        isManager: false,
      };
      (item.state === 'pending' ? current : open).push(item);
    }
  }

  if (input.modules.has('learning')) {
    for (const course of input.courses) {
      current.push({
        kind: 'course',
        id: course.courseId,
        title: course.displayName,
        subtitle: course.programName,
        description: null,
        positions: [],
        state: 'enrolled',
        isManager: false,
      });
    }
  }

  if (input.modules.has('serve')) {
    const memberTeamIds = new Set(input.teamMemberships.map(({ team_id }) => team_id));
    const currentApplicationTeams = new Set<number>();
    const latestApplicationByTeam = new Map<number, ApplicationInput>();

    for (const team of input.teamMemberships) {
      current.push({
        kind: 'team',
        id: team.team_id,
        title: team.name,
        subtitle: null,
        description: null,
        positions: [],
        state: team.is_leader === 1 ? 'leader' : 'joined',
        isManager: team.is_leader === 1,
      });
    }
    // The query is newest-first. Record exactly one latest outcome per team so
    // an older approval cannot override a newer rejection and hide re-apply.
    for (const application of input.applications) {
      if (!latestApplicationByTeam.has(application.team_id)) {
        latestApplicationByTeam.set(application.team_id, application);
      }
    }
    for (const application of latestApplicationByTeam.values()) {
      if (memberTeamIds.has(application.team_id)) continue;
      if (application.status !== 'P' && application.status !== 'A') continue;
      currentApplicationTeams.add(application.team_id);
      current.push({
        kind: 'team',
        id: application.team_id,
        title: application.team_name,
        subtitle: application.position_name,
        description: null,
        positions: application.position_name ? [application.position_name] : [],
        state: application.status === 'P' ? 'pending' : 'approved',
        isManager: false,
      });
    }
    for (const team of input.applicationTeams) {
      if (memberTeamIds.has(team.team_id) || currentApplicationTeams.has(team.team_id)) continue;
      open.push({
        kind: 'team',
        id: team.team_id,
        title: team.team_name,
        subtitle: team.ministry_name,
        description: null,
        positions: [...team.positions],
        state: 'open',
        isManager: false,
      });
    }
  }

  return { current, open };
}
