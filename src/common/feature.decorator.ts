import { SetMetadata } from '@nestjs/common';
import type { FeatureKey } from '../launchedFeatures';

/** Metadata key under which a controller/handler's feature is stored. */
export const FEATURE_KEY = 'launched-feature';

/**
 * The 404 body every feature gate returns (`LaunchedFeaturesGuard`,
 * `EarlyAccessGuard`, the link-preview gate), so a hidden feature reads the
 * same whichever gate refused it.
 */
export const FEATURE_NOT_AVAILABLE_MESSAGE =
  'This feature is not available yet.';

/**
 * Tags a controller (or handler) as belonging to a launchable product feature.
 * `LaunchedFeaturesGuard` reads this and returns 404 when the feature is off.
 *
 *   @Feature('jobs')
 *   @Controller('jobs')
 *   export class JobsController {}
 *
 * The `key` is typed to `FeatureKey`, so only keys defined in
 * `launchedFeatures` compile.
 */
export const Feature = (key: FeatureKey) => SetMetadata(FEATURE_KEY, key);
