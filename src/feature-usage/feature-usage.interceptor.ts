import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { FEATURE_KEY } from '../common/feature.decorator';
import { FeatureKey } from '../launchedFeatures';
import { FeatureUsageTallyService } from './feature-usage-tally.service';

/**
 * Counts one request against the feature its controller is tagged with.
 *
 * Reuses the `@Feature(...)` metadata `LaunchedFeaturesGuard` already reads, so
 * there is no second list of routes to keep in step with `launchedFeatures`.
 * Infrastructure controllers (auth, users, profiles, membership, security,
 * health, storage, notifications) carry no tag and are therefore never counted.
 *
 * Staff surfaces are excluded even though several of them carry a `@Feature(...)`
 * tag of their own (they need the tag for the launch gate). Depth deliberately
 * counts only rows a member can create, so counting staff requests toward reach
 * would pair a staff-driven reach number against a member-only depth number and
 * misreport the pairing as "people want this and something stops them". This
 * repo's convention is that guarded admin CRUD gets its own `Admin*Controller`
 * (see CLAUDE.md), which makes the controller class name a reliable signal for
 * "this is a staff surface" without reading anything from the request.
 *
 * Nest runs guards BEFORE interceptors, so arriving here means every guard
 * passed. `record()` runs before `next.handle()`, so a request whose handler
 * subsequently throws (a 404 on an unlaunched feature, a 401 from a logged-out
 * scanner, a 500) is still counted. Only the guard layer filters what reaches
 * here.
 */
@Injectable()
export class FeatureUsageInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tally: FeatureUsageTallyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const featureKey = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const isStaffSurface = context.getClass().name.startsWith('Admin');

    if (featureKey && !isStaffSurface) {
      this.tally.record(featureKey);
    }

    return next.handle();
  }
}
