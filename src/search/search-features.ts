import {
  launchedFeatures,
  type FeatureConfig,
  type FeatureKey,
} from '../launchedFeatures';
import { SearchResultType } from './dto/search.query';

/**
 * The launch-registry key that owns each search result type's data.
 *
 * `GET /search` carries no `@Feature(...)` tag of its own (it is one endpoint
 * federating twelve resources, and it stays reachable as long as any of them
 * is launched), so `LaunchedFeaturesGuard` never sees it. Without this map a
 * closed feature kept feeding the palette: with `jobs` flipped to
 * `launched: false`, search still returned job rows whose link lands on a
 * route that is hidden in every production build.
 *
 * This map records only WHICH feature each result type belongs to, mirroring
 * the `@Feature(...)` tag on the controller that serves that type's own pages.
 * Whether that feature is open is read from `launchedFeatures.ts` at call
 * time, so the registry stays the single source of truth and no second list of
 * "what is currently off" can drift away from it.
 *
 * `null` marks a type backed by always-on infrastructure: member profiles and
 * their personas are served by untagged controllers (`ProfilesController`,
 * `SubprofilesController`) and have no flag to read.
 *
 * Typed as a total `Record`, so a new `SearchResultType` fails to compile
 * until it declares the feature it belongs to.
 */
export const RESULT_TYPE_FEATURE: Record<SearchResultType, FeatureKey | null> =
  {
    // ProfilesController: untagged infrastructure.
    [SearchResultType.Member]: null,
    [SearchResultType.Community]: 'communities',
    [SearchResultType.Event]: 'events',
    [SearchResultType.Forum]: 'forum',
    // Reply bodies open their thread, so they ride the same flag as titles.
    [SearchResultType.ForumPost]: 'forum',
    // DirectoryService is the business directory, served by
    // `DirectoryController` under `@Feature('listings')`.
    [SearchResultType.Business]: 'listings',
    [SearchResultType.Magazine]: 'magazine',
    [SearchResultType.Job]: 'jobs',
    // `HousingDirectoryController` is tagged `housingListings`, not `housing`
    // (which owns the housing groups surface).
    [SearchResultType.Housing]: 'housingListings',
    [SearchResultType.Resource]: 'resources',
    // SubprofilesController: untagged infrastructure, like profiles.
    [SearchResultType.Subprofile]: null,
    // Topics are served by `TopicsController` under `@Feature('content')`.
    [SearchResultType.Topic]: 'content',
  };

/**
 * Whether search may run, and return, this result type's query.
 *
 * `features` is a parameter (defaulting to the real registry) purely so unit
 * tests can drive it with a fabricated registry, the same shape
 * `missingLaunchedFeatureEnv` uses. An unknown key reads as closed, so a
 * mistyped or removed feature fails shut rather than leaking rows.
 */
export function isResultTypeLaunched(
  resultType: SearchResultType,
  features: Record<string, FeatureConfig> = launchedFeatures,
): boolean {
  const feature = RESULT_TYPE_FEATURE[resultType];
  if (feature === null) return true;
  return features[feature]?.launched === true;
}

/**
 * Every result type `GET /search` will actually query and return right now,
 * in the enum's declaration order.
 *
 * Derived from `isResultTypeLaunched` — the very predicate `SearchService`'s
 * `wants()` calls — so the answer cannot drift from what a search does. This
 * exists because the frontend was rendering one tab per result type from a
 * hardcoded list: with `jobs` closed, the Jobs tab stayed on `/search` and
 * could only ever show "no results", which reads to a member as "your query
 * found nothing" when the truth is "this surface is not open". A hand-written
 * exclusion list in the frontend would have been a second copy of this
 * taxonomy, free to drift; the frontend reads this instead.
 *
 * `features` is a parameter for the same reason it is one on
 * `isResultTypeLaunched`: unit tests drive it with a fabricated registry.
 */
export function launchedResultTypes(
  features: Record<string, FeatureConfig> = launchedFeatures,
): SearchResultType[] {
  return Object.values(SearchResultType).filter((resultType) =>
    isResultTypeLaunched(resultType, features),
  );
}
