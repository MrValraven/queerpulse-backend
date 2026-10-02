import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminListingDraftsController } from './admin-listing-drafts.controller';
import { AdminListingDraftsService } from './admin-listing-drafts.service';

describe('AdminListingDraftsController', () => {
  it('is Admin only, with no moderator tier', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminListingDraftsController,
    ) as UserRole[];
    expect(roles).toEqual([UserRole.Admin]);
  });

  it('runs the active-member and roles guards on the whole class', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminListingDraftsController,
    ) as unknown[];
    expect(guards).toEqual([ActiveMemberGuard, RolesGuard]);
  });

  it('GET / delegates to the service with the page query', async () => {
    const page = { items: [], total: 0, page: 2, pageSize: 20 };
    const list = jest.fn().mockResolvedValue(page);
    const controller = new AdminListingDraftsController({
      list,
    } as unknown as AdminListingDraftsService);
    await expect(controller.list({ page: 2 })).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith({ page: 2 });
  });
});
