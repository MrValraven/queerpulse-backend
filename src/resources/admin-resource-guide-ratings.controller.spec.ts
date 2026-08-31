import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminResourceGuideRatingsController } from './admin-resource-guide-ratings.controller';
import { AdminResourceGuideRatingsService } from './admin-resource-guide-ratings.service';

describe('AdminResourceGuideRatingsController', () => {
  let controller: AdminResourceGuideRatingsController;
  let service: { list: jest.Mock };

  beforeEach(async () => {
    service = { list: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminResourceGuideRatingsController],
      providers: [
        { provide: AdminResourceGuideRatingsService, useValue: service },
        // `RolesOrStaffGuard` (class-level) injects the staff-grant repository.
        // The guard is never exercised here, so an inert mock is enough to let
        // the testing module instantiate it.
        {
          provide: getRepositoryToken(UserStaffRole),
          useValue: { exists: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();
    controller = module.get(AdminResourceGuideRatingsController);
  });

  it('is guarded by @Roles(UserRole.Admin)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminResourceGuideRatingsController,
    ) as UserRole[];
    expect(roles).toEqual([UserRole.Admin]);
  });

  it('GET / delegates to list with no arguments', async () => {
    const rows = [
      { contentKey: 'x', helpfulCount: 1, notHelpfulCount: 0, ratio: 1 },
    ];
    service.list.mockResolvedValue(rows);

    const result = await controller.list();

    expect(service.list).toHaveBeenCalledWith();
    expect(result).toBe(rows);
  });
});
