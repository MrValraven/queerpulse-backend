import { SetMetadata } from '@nestjs/common';
import { StaffRoleId } from '../../users/staff-roles.registry';

export const STAFF_ROLES_KEY = 'staff_roles';

/** Require the caller to hold at least one of these staff roles (admin is a superset). */
export const StaffRoles = (...roles: StaffRoleId[]) =>
  SetMetadata(STAFF_ROLES_KEY, roles);
