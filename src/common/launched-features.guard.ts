import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_KEY } from './feature.decorator';
import { FeatureKey, isFeatureLaunched } from '../launchedFeatures';

/**
 * Global guard that gates routes tagged with `@Feature(...)`.
 *
 * Registered in the global chain after the throttler but before CSRF/JWT, so a
 * request to an unlaunched feature returns 404 ("not available yet") instead of
 * a misleading 401/403 — while still being rate-limited. Routes without a
 * `@Feature` tag (all infrastructure routes) are unaffected.
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

    throw new NotFoundException('This feature is not available yet.');
  }
}
