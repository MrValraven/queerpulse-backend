import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FeatureAccessService } from '../early-access/feature-access.service';
import {
  FEATURE_KEY,
  FEATURE_NOT_AVAILABLE_MESSAGE,
} from './feature.decorator';
import { FeatureKey, isInEarlyAccess } from '../launchedFeatures';

/**
 * Global guard for the second phase of early-access gating.
 *
 * Registered right after `JwtAuthGuard` and before `PlatformLockdownGuard`.
 * `LaunchedFeaturesGuard` has already let a request for an unlaunched
 * `earlyAccess` feature through on the strength of an `access_token` cookie;
 * by now JWT has populated `req.user`, so this guard asks
 * `FeatureAccessService` whether that member holds a grant and returns the
 * same 404 "not available yet" when they do not.
 *
 * It only acts on features currently in early access. Untagged routes,
 * launched features and non-HTTP contexts pass (gateways check for
 * themselves), and an unlaunched feature without `earlyAccess` never reaches
 * here because `LaunchedFeaturesGuard` 404s it first.
 *
 * A `@Public()` route tagged with an early-access feature skips JWT, so it has
 * no `req.user` and 404s here for everyone. That is the intended answer while
 * the feature is unlaunched; the route opens to anonymous callers when the
 * feature launches.
 */
@Injectable()
export class EarlyAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureAccess: FeatureAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature || !isInEarlyAccess(feature)) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: CurrentUserData }>();
    if (!user) {
      throw new NotFoundException(FEATURE_NOT_AVAILABLE_MESSAGE);
    }

    const hasAccess = await this.featureAccess.canUseFeature(
      feature,
      user.userId,
    );
    if (!hasAccess) {
      throw new NotFoundException(FEATURE_NOT_AVAILABLE_MESSAGE);
    }
    return true;
  }
}
