import { AdminFeatureUsageController } from './admin-feature-usage.controller';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { FEATURE_KEY } from '../common/feature.decorator';

describe('AdminFeatureUsageController', () => {
  it('is admin-only', () => {
    const roles = Reflect.getMetadata('roles', AdminFeatureUsageController);
    expect(roles).toContain(UserRole.Admin);
    expect(Roles).toBeDefined();
  });

  it('carries no feature tag, so the panel never counts itself', () => {
    expect(
      Reflect.getMetadata(FEATURE_KEY, AdminFeatureUsageController),
    ).toBeUndefined();
  });

  it('defaults the range to 30 days', async () => {
    const getUsage = jest.fn().mockResolvedValue({ rangeDays: 30 });
    const controller = new AdminFeatureUsageController({ getUsage } as never);
    await controller.getUsage(undefined);
    expect(getUsage).toHaveBeenCalledWith(30);
  });

  it('clamps a value above the maximum down to the maximum', async () => {
    const getUsage = jest.fn().mockResolvedValue({ rangeDays: 365 });
    const controller = new AdminFeatureUsageController({ getUsage } as never);
    await controller.getUsage(100000);
    expect(getUsage).toHaveBeenCalledWith(365);
  });

  it('clamps a value below the minimum up to the minimum', async () => {
    const getUsage = jest.fn().mockResolvedValue({ rangeDays: 1 });
    const controller = new AdminFeatureUsageController({ getUsage } as never);
    await controller.getUsage(0);
    expect(getUsage).toHaveBeenCalledWith(1);
  });
});
