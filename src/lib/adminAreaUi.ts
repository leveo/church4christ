import { grantableAreasForRole, type GrantableArea } from './adminAreas';
import type { SessionUser } from './types';

export interface GrantCheckboxState {
  checked: boolean;
  hidden: boolean;
  roleDisabled: boolean;
}

export function grantCheckboxStateForRole(
  role: SessionUser['role'],
  area: GrantableArea,
  checked: boolean,
): GrantCheckboxState {
  const allowed = grantableAreasForRole(role).some((candidate) => candidate === area);

  return {
    checked: allowed && checked,
    hidden: !allowed,
    roleDisabled: !allowed,
  };
}
