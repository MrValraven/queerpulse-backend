import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../users/entities/user.entity';
import { UserStaffRole } from '../../users/entities/user-staff-role.entity';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * Gate Housing listing/group moderation to either the flat platform tier
 * (Moderator/Admin, the pre-existing behaviour) OR a member who holds the
 * additive `housing_moderator` staff role (see `staff-roles.registry.ts`).
 * A platform Member with only the staff role passes; a real platform
 * Moderator/Admin keeps passing unchanged via the fast path. Housing co-ops
 * (`admin-housing.controller.ts`) are out of scope and stay Admin-only via
 * the plain `RolesGuard`.
 */
@Injectable()
export class HousingModerationGuard implements CanActivate {
  constructor(
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user) return false;

    const role = user.role as UserRole;
    if (role === UserRole.Moderator || role === UserRole.Admin) return true;

    return this.staffRoles.exists({
      where: { userId: user.userId, role: 'housing_moderator' },
    });
  }
}
