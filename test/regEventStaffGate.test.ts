// The one table behind the per-event route class and the middleware role check.
import { describe, expect, it } from 'vitest';
import { classifyRoute, regEventStaffGate } from '../src/lib/routePolicy';

describe('regEventStaffGate', () => {
  it('maps each per-event page to its event and capability', () => {
    expect(regEventStaffGate('/admin/registration/7')).toEqual({ eventId: 7, need: 'view' });
    expect(regEventStaffGate('/admin/registration/7/')).toEqual({ eventId: 7, need: 'view' });
    expect(regEventStaffGate('/admin/registration/7/checkin')).toEqual({ eventId: 7, need: 'checkin' });
    for (const tail of ['export.csv', 'export-people.csv', 'badges', 'sign-in-sheet']) {
      expect(regEventStaffGate(`/admin/registration/12/${tail}`)).toEqual({ eventId: 12, need: 'view' });
    }
  });

  it('knows nothing else, so everything else stays registration-admin only', () => {
    for (const path of ['/admin/registration', '/admin/registration/x', '/admin/registration/7/other', '/admin/registration/7/badges/x', '/admin/registration/7/../8', '/admin/people', '/admin/registration/99999999999999999999']) {
      expect(regEventStaffGate(path), path).toBeNull();
    }
  });

  it('is exactly what classifies as regEventStaff', () => {
    for (const path of ['/admin/registration/7', '/admin/registration/7/checkin', '/admin/registration/7/badges', '/admin/registration/7/export.csv']) {
      expect(classifyRoute(path), path).toBe('regEventStaff');
    }
    for (const path of ['/admin/registration', '/admin/registration/7/other']) expect(classifyRoute(path), path).not.toBe('regEventStaff');
  });
});
