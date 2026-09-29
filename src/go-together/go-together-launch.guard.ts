import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { isFeatureLaunched } from '../launchedFeatures';

/**
 * Go together runs only while both its own key and `events` are launched:
 * every Go together route, group and cron pass belongs to a gathering, and
 * with `events` off no member can reach the gathering it would serve.
 */
export function isGoTogetherLaunched(): boolean {
  return isFeatureLaunched('goTogether') && isFeatureLaunched('events');
}

/**
 * Second feature gate for the Go together routes.
 *
 * `@Feature('goTogether')` on the event and group controllers makes the global
 * `LaunchedFeaturesGuard` 404 them while the Go together key is off. That
 * guard reads a single key per route, so this one adds the `events` half: with
 * gatherings switched off, `/events/:slug/go-together` and the group routes
 * answer the same 404 the global guard gives. The questionnaire controller
 * stays on `events` so members can read and delete their answers while Go
 * together is dark; this guard alone gates saving new answers there.
 *
 * Bound with `@UseGuards`, so it runs after the JWT guard: a signed-out caller
 * sees 401 before 404, which reveals strictly less.
 */
@Injectable()
export class GoTogetherLaunchGuard implements CanActivate {
  canActivate(): boolean {
    if (isGoTogetherLaunched()) return true;
    throw new NotFoundException('This feature is not available yet.');
  }
}
