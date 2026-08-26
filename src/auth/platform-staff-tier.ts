import { UserRole } from '../users/entities/user.entity';

/**
 * True when the caller's ACCOUNT TIER is platform moderator or admin, ignoring
 * every additive staff grant they may hold (`staff-roles.registry.ts`).
 *
 * Why a tier check exists alongside the guards: `RolesOrStaffGuard` lets a
 * grant satisfy an endpoint's `@Roles(...)` tier, so past the guard a handler
 * can no longer assume its caller is Moderator/Admin. Any endpoint on that
 * union whose response carries something the registry reserves for platform
 * staff — private report content, a member sanction, a flagger's identity —
 * has to serve the grant holder a narrower body. This is the single test those
 * handlers ask, so "is this reader platform staff?" is answered the same way
 * everywhere instead of being re-derived per file.
 *
 * It is never an authorization decision on its own: the guard has already
 * decided who may call the endpoint at all. This only decides how much of the
 * answer they get.
 */
export function isPlatformStaffTier(role: string): boolean {
  // `CurrentUserData.role` is a plain `string` (it comes off the JWT), so it is
  // narrowed the same way `RolesOrStaffGuard` narrows it before comparing.
  const accountTier = role as UserRole;
  return accountTier === UserRole.Moderator || accountTier === UserRole.Admin;
}
