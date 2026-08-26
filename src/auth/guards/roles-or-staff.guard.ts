import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../users/entities/user.entity';
import { UserStaffRole } from '../../users/entities/user-staff-role.entity';
import { StaffRoleId } from '../../users/staff-roles.registry';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../decorators/staff-roles.decorator';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * The union gate: pass on the account TIER (`@Roles(...)`) OR on an additive
 * staff GRANT (`@StaffRoles(...)`). This is the generic form of
 * `HousingModerationGuard`, which hand-wrote the same union for a single role.
 *
 * Why it exists: before this, delegating one admin queue meant promoting the
 * person to platform Admin, which also handed them member suspension, the
 * lockdown switch, governance finances and every private report. A grant opens
 * exactly the surfaces its `grants:` line names in `staff-roles.registry.ts`
 * and nothing else.
 *
 * Behaviour, in order:
 *   - neither decorator present -> allow (same as `RolesGuard`);
 *   - the caller's tier is in the `@Roles(...)` list -> allow. With no
 *     `@StaffRoles(...)` in scope this is byte-for-byte `RolesGuard`, admins
 *     included: a controller that only carries `@Roles` behaves identically to
 *     today, and an admin left out of a `@Roles` list is still refused;
 *   - otherwise, with a grant required: Admin short-circuits as a superset of
 *     every grant (no query), everyone else needs one of the required grants
 *     (one indexed lookup).
 *
 * NARROWING A METHOD. `getAllAndOverride` lets the handler override the class,
 * so a privileged write inside a delegated controller is re-closed with an
 * EMPTY `@StaffRoles()` on the method: the grant axis is switched off there and
 * the method falls back to its `@Roles(...)` alone. This mirrors the empty
 * `@Roles()` idiom already used in `moderation.controller.ts`. Any method that
 * narrows to `@Roles(UserRole.Admin)` inside a class carrying `@StaffRoles`
 * MUST also carry the empty `@StaffRoles()`, or the class-level grant would
 * quietly re-open it.
 */
@Injectable()
export class RolesOrStaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredStaffRoles = this.reflector.getAllAndOverride<StaffRoleId[]>(
      STAFF_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasRoleRequirement = !!requiredRoles && requiredRoles.length > 0;
    const hasStaffRequirement =
      !!requiredStaffRoles && requiredStaffRoles.length > 0;
    if (!hasRoleRequirement && !hasStaffRequirement) return true;

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user) return false;
    const role = user.role as UserRole;

    if (
      hasRoleRequirement &&
      (requiredRoles as readonly string[]).includes(role)
    ) {
      return true;
    }
    if (!hasStaffRequirement) return false;
    if (role === UserRole.Admin) return true; // superset of every grant, no query

    return this.staffRoles.exists({
      where: requiredStaffRoles.map((staffRoleId) => ({
        userId: user.userId,
        role: staffRoleId,
      })),
    });
  }
}
