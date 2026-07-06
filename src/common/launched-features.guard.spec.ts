import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LaunchedFeaturesGuard } from './launched-features.guard';
import { isFeatureLaunched } from '../launchedFeatures';

jest.mock('../launchedFeatures', () => ({
  isFeatureLaunched: jest.fn(),
}));

const mockIsLaunched = isFeatureLaunched as jest.MockedFunction<
  typeof isFeatureLaunched
>;

describe('LaunchedFeaturesGuard', () => {
  function makeGuard(featureKey: string | undefined) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(featureKey),
    } as unknown as Reflector;
    const guard = new LaunchedFeaturesGuard(reflector);
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    return { guard, context };
  }

  afterEach(() => jest.clearAllMocks());

  it('allows routes with no @Feature tag', () => {
    const { guard, context } = makeGuard(undefined);
    expect(guard.canActivate(context)).toBe(true);
    expect(mockIsLaunched).not.toHaveBeenCalled();
  });

  it('allows a route whose feature is launched', () => {
    mockIsLaunched.mockReturnValue(true);
    const { guard, context } = makeGuard('communities');
    expect(guard.canActivate(context)).toBe(true);
    expect(mockIsLaunched).toHaveBeenCalledWith('communities');
  });

  it('throws 404 "not available yet" when the feature is not launched', () => {
    mockIsLaunched.mockReturnValue(false);
    const { guard, context } = makeGuard('cinema');
    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
    expect(() => guard.canActivate(context)).toThrow(
      'This feature is not available yet.',
    );
  });
});
