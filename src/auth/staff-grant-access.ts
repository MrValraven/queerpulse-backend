import { Repository } from 'typeorm';
import { UserRole } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { StaffRoleId } from '../users/staff-roles.registry';

/**
 * Whether a caller is an Admin or holds one of `requiredStaffRoles`, read the
 * way `RolesOrStaffGuard` reads it: Admin is a superset of every grant and
 * answers without a query, an empty list admits nobody else, and anyone else
 * needs a `user_staff_roles` row for one of the listed grants (one indexed
 * lookup).
 *
 * The guard asks this for HTTP routes. Surfaces outside a guard (a socket
 * handshake and its per-frame recheck, a single upload kind inside a shared
 * presign route, a storage key family inside the file route) ask the same
 * question here, so "who may use this grant's surfaces" is answered once.
 * `role` is the caller's account tier: the live `users.role` on a socket, the
 * JWT claim on an HTTP request.
 */
export async function isAdminOrHoldsStaffRole(
  staffRoles: Repository<UserStaffRole>,
  caller: { userId: string; role: string },
  requiredStaffRoles: readonly StaffRoleId[],
): Promise<boolean> {
  if ((caller.role as UserRole) === UserRole.Admin) return true;
  if (requiredStaffRoles.length === 0) return false;
  return staffRoles.exists({
    where: requiredStaffRoles.map((staffRoleId) => ({
      userId: caller.userId,
      role: staffRoleId,
    })),
  });
}
