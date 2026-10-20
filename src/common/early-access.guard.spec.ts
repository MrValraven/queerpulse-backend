import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import type { FeatureAccessService } from '../early-access/feature-access.service';
import { EarlyAccessGuard } from './early-access.guard';
import { isInEarlyAccess } from '../launchedFeatures';

jest.mock('../launchedFeatures', () => ({
  isFeatureLaunched: jest.fn(),
  isEarlyAccessFeature: jest.fn(),
  isInEarlyAccess: jest.fn(),
  earlyAccessFeatureKeys: jest.fn(),
  isFeatureKey: jest.fn(),
}));

const mockIsInEarlyAccess = isInEarlyAccess as jest.MockedFunction<
  typeof isInEarlyAccess
>;

const MEMBER: CurrentUserData = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'tester@example.com',
  status: 'active',
  role: 'member',
};

describe('EarlyAccessGuard', () => {
  function makeGuard(
    featureKey: string | undefined,
    options: {
      user?: CurrentUserData;
      type?: 'http' | 'ws';
      canUseFeature?: boolean;
    } = {},
  ) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(featureKey),
    } as unknown as Reflector;
    const canUseFeature = jest
      .fn()
      .mockResolvedValue(options.canUseFeature ?? false);
    const featureAccess = {
      canUseFeature,
    } as unknown as FeatureAccessService;
    const guard = new EarlyAccessGuard(reflector, featureAccess);
    const request = { user: options.user };
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      getType: () => options.type ?? 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { guard, context, canUseFeature };
  }

  beforeEach(() => {
    mockIsInEarlyAccess.mockReturnValue(true);
  });

  afterEach(() => jest.clearAllMocks());

  it('allows routes with no @Feature tag', async () => {
    const { guard, context, canUseFeature } = makeGuard(undefined);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(canUseFeature).not.toHaveBeenCalled();
  });

  it('allows a feature that is not in early access (launched, or owned by LaunchedFeaturesGuard)', async () => {
    mockIsInEarlyAccess.mockReturnValue(false);
    const { guard, context, canUseFeature } = makeGuard('communities');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockIsInEarlyAccess).toHaveBeenCalledWith('communities');
    expect(canUseFeature).not.toHaveBeenCalled();
  });

  it('allows non-HTTP contexts, which gateways gate themselves', async () => {
    const { guard, context, canUseFeature } = makeGuard('quizshow', {
      type: 'ws',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(canUseFeature).not.toHaveBeenCalled();
  });

  it('throws 404 when there is no signed-in user', async () => {
    const { guard, context, canUseFeature } = makeGuard('quizshow');
    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
    await expect(guard.canActivate(context)).rejects.toThrow(
      'This feature is not available yet.',
    );
    expect(canUseFeature).not.toHaveBeenCalled();
  });

  it('throws 404 for a member without a grant', async () => {
    const { guard, context, canUseFeature } = makeGuard('quizshow', {
      user: MEMBER,
      canUseFeature: false,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      'This feature is not available yet.',
    );
    expect(canUseFeature).toHaveBeenCalledWith('quizshow', MEMBER.userId);
  });

  it('allows a member holding a grant', async () => {
    const { guard, context, canUseFeature } = makeGuard('quizshow', {
      user: MEMBER,
      canUseFeature: true,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(canUseFeature).toHaveBeenCalledWith('quizshow', MEMBER.userId);
  });
});
