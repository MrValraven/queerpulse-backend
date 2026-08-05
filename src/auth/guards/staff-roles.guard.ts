import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../users/entities/user.entity';
import { UserStaffRole } from '../../users/entities/user-staff-role.entity';
import { StaffRoleId } from '../../users/staff-roles.registry';
import { STAFF_ROLES_KEY } from '../decorators/staff-roles.decorator';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * Gate an endpoint on additive staff-role grants. Admins are a superset and
 * short-circuit without a query; everyone else must hold at least one of the
 * required grants (one indexed lookup). The account tier (RolesGuard) is
 * unaffected — this is a separate, additive axis.
 */
@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<StaffRoleId[]>(
      STAFF_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user) return false;
    const role = user.role as UserRole;
    if (role === UserRole.Admin) return true; // superset, no query

    return this.staffRoles.exists({
      where: required.map((role) => ({ userId: user.userId, role })),
    });
  }
}
