import { SetMetadata } from '@nestjs/common';
import type { FeatureKey } from '../launchedFeatures';

/** Metadata key under which a controller/handler's feature is stored. */
export const FEATURE_KEY = 'launched-feature';

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
