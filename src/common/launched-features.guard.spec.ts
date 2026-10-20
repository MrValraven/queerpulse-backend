import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LaunchedFeaturesGuard } from './launched-features.guard';
import { isEarlyAccessFeature, isFeatureLaunched } from '../launchedFeatures';

jest.mock('../launchedFeatures', () => ({
  isFeatureLaunched: jest.fn(),
  isEarlyAccessFeature: jest.fn(),
  isInEarlyAccess: jest.fn(),
  earlyAccessFeatureKeys: jest.fn(),
  isFeatureKey: jest.fn(),
}));

const mockIsLaunched = isFeatureLaunched as jest.MockedFunction<
  typeof isFeatureLaunched
>;
const mockIsEarlyAccess = isEarlyAccessFeature as jest.MockedFunction<
  typeof isEarlyAccessFeature
>;

describe('LaunchedFeaturesGuard', () => {
  function makeGuard(
    featureKey: string | undefined,
    options: {
      cookies?: Record<string, string>;
      type?: 'http' | 'ws';
    } = {},
  ) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(featureKey),
    } as unknown as Reflector;
    const guard = new LaunchedFeaturesGuard(reflector);
    const request = { cookies: options.cookies };
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      getType: () => options.type ?? 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { guard, context };
  }

  beforeEach(() => {
    mockIsEarlyAccess.mockReturnValue(false);
  });

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

  it('throws 404 for an unlaunched feature without early access even with an access-token cookie', () => {
    mockIsLaunched.mockReturnValue(false);
    mockIsEarlyAccess.mockReturnValue(false);
    const { guard, context } = makeGuard('cinema', {
      cookies: { access_token: 'signed.jwt.value' },
    });
    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });

  it('lets an early-access HTTP request with an access-token cookie through to EarlyAccessGuard', () => {
    mockIsLaunched.mockReturnValue(false);
    mockIsEarlyAccess.mockReturnValue(true);
    const { guard, context } = makeGuard('quizshow', {
      cookies: { access_token: 'signed.jwt.value' },
    });
    expect(guard.canActivate(context)).toBe(true);
    expect(mockIsEarlyAccess).toHaveBeenCalledWith('quizshow');
  });

  it('lets an early-access HTTP request without a cookie through so JwtAuthGuard can answer 401', () => {
    // The access cookie lives as long as the JWT, so a grantee whose token
    // lapsed arrives with none. Passing through lets JwtAuthGuard 401 and the
    // frontend refresh; EarlyAccessGuard still 404s a signed-in non-grantee.
    mockIsLaunched.mockReturnValue(false);
    mockIsEarlyAccess.mockReturnValue(true);
    const { guard, context } = makeGuard('quizshow', { cookies: {} });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('lets an early-access HTTP request with no cookie jar at all through', () => {
    mockIsLaunched.mockReturnValue(false);
    mockIsEarlyAccess.mockReturnValue(true);
    const { guard, context } = makeGuard('quizshow');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('gives a non-HTTP context no early-access pass-through', () => {
    mockIsLaunched.mockReturnValue(false);
    mockIsEarlyAccess.mockReturnValue(true);
    const { guard, context } = makeGuard('quizshow', {
      cookies: { access_token: 'signed.jwt.value' },
      type: 'ws',
    });
    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });
});
