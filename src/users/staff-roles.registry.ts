/**
 * Code-defined catalog of additive "staff roles" — functional grants that sit
 * on TOP of the account tier (User.role), not tiers above it. A member may hold
 * any set of these independent of being member/moderator/admin.
 *
 * Adding a future role: add one entry here + wire its @StaffRoles() guard on the
 * endpoints it should open. The `role` column is a varchar validated against
 * this map, so NO migration is needed for a new role. Admin is always a superset
 * (see StaffRolesGuard), so admins are never granted these explicitly.
 */
export type StaffRoleId =
  'magazine_editor' | 'magazine_writer' | 'housing_moderator';

export interface StaffRoleDef {
  id: StaffRoleId;
  /** Human-readable note of what this unlocks. Not enforced — guards key off id. */
  grants: string[];
}

export const STAFF_ROLES: Record<StaffRoleId, StaffRoleDef> = {
  magazine_editor: {
    id: 'magazine_editor',
    grants: ['The magazine editorial desk (/magazine/editor)'],
  },
  magazine_writer: {
    id: 'magazine_writer',
    grants: ['Draft and submit magazine pieces (workspace ships in Spec 2)'],
  },
  housing_moderator: {
    id: 'housing_moderator',
    grants: [
      'Moderate Housing listings and groups (admin/housing-listings, admin/housing-groups)',
    ],
  },
};

export const STAFF_ROLE_IDS = Object.keys(STAFF_ROLES) as StaffRoleId[];

export function isStaffRoleId(value: string): value is StaffRoleId {
  return Object.prototype.hasOwnProperty.call(STAFF_ROLES, value);
}
