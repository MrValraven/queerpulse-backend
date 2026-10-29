import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { FEATURE_KEY } from '../common/feature.decorator';
import { isCreatorDraftRequest } from '../creator-drafts/creator-draft-request-log';
import { FeatureKey } from '../launchedFeatures';
import { isStudioLandingPublicRequest } from '../studio/studio-landing-request-log';
import { isTrackedFeature } from './feature-depth';
import { FeatureUsageTallyService } from './feature-usage-tally.service';
import { isProfileEventsRequest } from './profile-events-request';

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
 * The creator draft routes carry `@Feature` tags and count nothing.
 *
 * `GET /profiles/:slug/events` carries `@Feature('events')` and counts
 * nothing either: it answers every profile view, so counting it would turn
 * profile traffic into events reach (`isProfileEventsRequest`).
 *
 * The two public Studio page routes (`GET /studio/landing` and the preview
 * stream) count nothing either: they serve strangers and record nothing
 * about a visit (`isStudioLandingPublicRequest`). The `studio` key sits in
 * `UNTRACKED_FEATURES` as well; this check keeps the routes out on its own.
 *
 * Keys in `UNTRACKED_FEATURES` (`feature-depth.ts`) are never counted: Go
 * together allows no analytics of any of its actions.
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

    const request = context
      .switchToHttp()
      .getRequest<{ originalUrl?: string; url?: string; method?: string }>();
    const isCreatorDraftSurface = isCreatorDraftRequest(
      request.originalUrl ?? request.url,
    );
    const isProfileEventsSurface = isProfileEventsRequest(
      request.originalUrl ?? request.url,
    );
    const isStudioLandingPublicSurface = isStudioLandingPublicRequest(
      request.originalUrl ?? request.url,
      request.method,
    );

    if (
      featureKey &&
      !isStaffSurface &&
      !isCreatorDraftSurface &&
      !isProfileEventsSurface &&
      !isStudioLandingPublicSurface &&
      isTrackedFeature(featureKey)
    ) {
      this.tally.record(featureKey);
    }

    return next.handle();
  }
}
