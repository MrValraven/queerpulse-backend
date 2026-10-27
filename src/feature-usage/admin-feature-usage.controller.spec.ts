import { BadRequestException } from '@nestjs/common';
import { AdminFeatureUsageController } from './admin-feature-usage.controller';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { FEATURE_KEY } from '../common/feature.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import {
  resolveUsageRange,
  UsageRange,
  UsageRangeQuery,
} from './feature-usage-range';

const NOW = new Date('2026-10-26T15:00:00Z');

/** A service double whose `resolveRange` runs the real range rules against a
 *  fixed clock, so the controller spec checks the wiring end to end. The
 *  detail service double records the key and range it receives. */
function buildController() {
  const getUsage = jest.fn().mockResolvedValue({});
  const resolveRange = jest.fn((query: UsageRangeQuery) =>
    resolveUsageRange(query, NOW, 730),
  );
  const getDetail = jest.fn().mockResolvedValue({});
  const controller = new AdminFeatureUsageController(
    { getUsage, resolveRange } as never,
    { getDetail } as never,
  );
  return { controller, getUsage, resolveRange, getDetail };
}

function resolvedRangeOf(getUsage: jest.Mock): UsageRange | undefined {
  const [firstCall] = getUsage.mock.calls as Array<[UsageRange]>;
  return firstCall?.[0];
}

function detailCallOf(
  getDetail: jest.Mock,
): { featureKey: string; range: UsageRange } | undefined {
  const [firstCall] = getDetail.mock.calls as Array<[string, UsageRange]>;
  if (!firstCall) return undefined;
  return { featureKey: firstCall[0], range: firstCall[1] };
}

describe('AdminFeatureUsageController', () => {
  it('keeps admin as the only account tier', () => {
    const roles: unknown = Reflect.getMetadata(
      'roles',
      AdminFeatureUsageController,
    );
    expect(roles).toContain(UserRole.Admin);
    expect(Roles).toBeDefined();
  });

  it('opens to the product_manager grant and to no other', () => {
    expect(
      Reflect.getMetadata(STAFF_ROLES_KEY, AdminFeatureUsageController),
    ).toEqual(['product_manager']);
  });

  it('carries no feature tag, so the panel never counts itself', () => {
    expect(
      Reflect.getMetadata(FEATURE_KEY, AdminFeatureUsageController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        FEATURE_KEY,
        // Read as a metadata target only and never invoked, so the unbound
        // `this` the rule warns about cannot arise.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        AdminFeatureUsageController.prototype.getUsage,
      ),
    ).toBeUndefined();
  });

  it('defaults the range to 30 days', async () => {
    const { controller, getUsage, resolveRange } = buildController();
    await controller.getUsage(undefined, undefined, undefined);

    expect(resolveRange).toHaveBeenCalledWith({
      rangeDays: undefined,
      from: undefined,
      to: undefined,
    });
    expect(resolvedRangeOf(getUsage)?.rangeDays).toBe(30);
  });

  it('clamps a value above the maximum down to the maximum', async () => {
    const { controller, getUsage } = buildController();
    await controller.getUsage('100000');
    expect(resolvedRangeOf(getUsage)?.rangeDays).toBe(365);
  });

  it('clamps a value below the minimum up to the minimum', async () => {
    const { controller, getUsage } = buildController();
    await controller.getUsage('0');
    expect(resolvedRangeOf(getUsage)?.rangeDays).toBe(1);
  });

  it('passes a custom from and to through to the range rules', async () => {
    const { controller, getUsage } = buildController();
    await controller.getUsage(undefined, '2026-10-01', '2026-10-10');

    const range = resolvedRangeOf(getUsage);
    expect(range?.rangeDays).toBe(10);
    expect(range?.rangeStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects a rangeDays of abc with feature_usage_range_invalid_days', () => {
    const { controller, getUsage } = buildController();

    let caughtError: unknown;
    try {
      void controller.getUsage('abc');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect((caughtError as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: 'feature_usage_range_invalid_days',
    });
    expect(getUsage).not.toHaveBeenCalled();
  });

  describe('getDetail', () => {
    it('carries no feature tag on the detail route either', () => {
      expect(
        Reflect.getMetadata(
          FEATURE_KEY,
          // Read as a metadata target only and never invoked, so the unbound
          // `this` the rule warns about cannot arise.
          // eslint-disable-next-line @typescript-eslint/unbound-method
          AdminFeatureUsageController.prototype.getDetail,
        ),
      ).toBeUndefined();
    });

    it('passes the feature key and a default 30-day range to the detail service', async () => {
      const { controller, getDetail, resolveRange } = buildController();
      await controller.getDetail('forum', undefined, undefined, undefined);

      expect(resolveRange).toHaveBeenCalledWith({
        rangeDays: undefined,
        from: undefined,
        to: undefined,
      });
      const detailCall = detailCallOf(getDetail);
      expect(detailCall?.featureKey).toBe('forum');
      expect(detailCall?.range.rangeDays).toBe(30);
    });

    it('resolves a custom from and to through the same range rules', async () => {
      const { controller, getDetail } = buildController();
      await controller.getDetail(
        'housingListings',
        undefined,
        '2026-10-01',
        '2026-10-10',
      );

      const detailCall = detailCallOf(getDetail);
      expect(detailCall?.featureKey).toBe('housingListings');
      expect(detailCall?.range.rangeDays).toBe(10);
      expect(detailCall?.range.rangeStart.toISOString()).toBe(
        '2026-10-01T00:00:00.000Z',
      );
    });

    it('rejects a rangeDays of abc with feature_usage_range_invalid_days before any detail read', () => {
      const { controller, getDetail } = buildController();

      let caughtError: unknown;
      try {
        void controller.getDetail('forum', 'abc');
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(BadRequestException);
      expect((caughtError as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code: 'feature_usage_range_invalid_days',
      });
      expect(getDetail).not.toHaveBeenCalled();
    });
  });
});
