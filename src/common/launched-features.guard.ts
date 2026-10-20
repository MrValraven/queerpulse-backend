import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  FEATURE_KEY,
  FEATURE_NOT_AVAILABLE_MESSAGE,
} from './feature.decorator';
import {
  FeatureKey,
  isEarlyAccessFeature,
  isFeatureLaunched,
} from '../launchedFeatures';

/**
 * Global guard that gates routes tagged with `@Feature(...)`.
 *
 * Registered in the global chain after the throttler but before CSRF/JWT, so a
 * request to an unlaunched feature returns 404 ("not available yet") instead of
 * a misleading 401/403, while still being rate-limited. Routes without a
 * `@Feature` tag (all infrastructure routes) are unaffected.
 *
 * Early-access features are gated in two phases. This guard runs before the
 * user is known, so it lets every HTTP request for a feature flagged
 * `earlyAccess` through. `JwtAuthGuard` then answers an anonymous or expired
 * caller with 401, which the frontend meets by refreshing and retrying, and
 * `EarlyAccessGuard` answers a signed-in member without a grant with 404.
 * The guard reads no cookie on purpose: the access cookie lives exactly as
 * long as the JWT, so a grantee whose token has lapsed carries none, and a
 * 404 here would skip the refresh.
 *
 * Non-HTTP contexts (socket message handlers also run the global chain) get no
 * pass-through: a tagged handler there 404s while its feature is unlaunched,
 * as it always has. Gateways check early access themselves.
 */
@Injectable()
export class LaunchedFeaturesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!feature || isFeatureLaunched(feature)) {
      return true;
    }

    if (isEarlyAccessFeature(feature) && context.getType() === 'http') {
      return true;
    }

    throw new NotFoundException(FEATURE_NOT_AVAILABLE_MESSAGE);
  }
}
