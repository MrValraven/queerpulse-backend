import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { isFeatureLaunched } from '../launchedFeatures';
import { LINK_PREVIEW_SURFACES } from './link-preview.constants';

/**
 * Feature gate for the unfurl endpoint.
 *
 * `@Feature('messaging')` cannot express this route: the decorator holds a
 * single key, and unfurling is shared by messaging, the forum and the feed. A
 * `@Feature('messaging')` tag therefore said "the forum may not unfurl", which
 * is why a pasted URL in a thread stayed plain text. This guard says the honest
 * thing instead: the endpoint answers while ANY link-pasting surface is
 * launched, and returns the same 404 `LaunchedFeaturesGuard` returns once they
 * are all off.
 *
 * It widens WHICH surfaces may call the endpoint and nothing else. Every other
 * guard on the controller is untouched, so the caller must still be an
 * authenticated active member and is still rate-limited; there is no path here
 * for an anonymous request.
 *
 * Bound with `@UseGuards` rather than globally, so it runs after the JWT guard
 * in the chain. The only visible difference from the global feature guard is
 * that a signed-out caller hitting a fully-disabled endpoint sees 401 before
 * 404, which reveals strictly less.
 */
@Injectable()
export class LinkPreviewFeatureGuard implements CanActivate {
  canActivate(): boolean {
    const isAnySurfaceLaunched = LINK_PREVIEW_SURFACES.some((featureKey) =>
      isFeatureLaunched(featureKey),
    );
    if (isAnySurfaceLaunched) {
      return true;
    }
    throw new NotFoundException('This feature is not available yet.');
  }
}
