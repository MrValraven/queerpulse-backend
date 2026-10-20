import type { EntityManager } from 'typeorm';
import {
  type FeatureKey,
  isEarlyAccessFeature,
  isFeatureKey,
  isFeatureLaunched,
  launchedFeatures,
} from '../launchedFeatures';

/**
 * Raw reads for per-viewer feature access. They use table names only, so a
 * caller with any `EntityManager` (the Events, Quizshow and Auth services, the
 * Quizshow gateway) asks them without registering the grant entity or
 * importing a provider.
 *
 * Every read answers from the registry first: a launched feature is open to
 * everyone and a feature without `earlyAccess` is closed to everyone, so
 * neither runs a query.
 */

/** $1 user id, $2 feature key. Served by `UQ_feature_early_access_grants_user_feature`. */
export const VIEWER_HAS_EARLY_ACCESS_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM "feature_early_access_grants"
    WHERE "user_id" = $1 AND "feature_key" = $2
  ) AS "exists"
`;

/** $1 user ids, $2 feature key. */
export const USERS_WITH_EARLY_ACCESS_SQL = `
  SELECT "user_id" FROM "feature_early_access_grants"
  WHERE "user_id" = ANY($1::uuid[]) AND "feature_key" = $2
`;

/** $1 user id. */
export const EARLY_ACCESS_KEYS_FOR_USER_SQL = `
  SELECT "feature_key" FROM "feature_early_access_grants"
  WHERE "user_id" = $1
`;

/** Whether `viewerId` may use `featureKey` right now. */
export async function canViewerUseFeature(
  manager: EntityManager,
  featureKey: FeatureKey,
  viewerId: string | null,
): Promise<boolean> {
  if (isFeatureLaunched(featureKey)) {
    return true;
  }
  if (!isEarlyAccessFeature(featureKey) || viewerId === null) {
    return false;
  }
  const rows: { exists: boolean }[] = await manager.query(
    VIEWER_HAS_EARLY_ACCESS_SQL,
    [viewerId, featureKey],
  );
  return rows[0]?.exists === true;
}

/** The members of `userIds` who may use `featureKey`, in input order. */
export async function usersWithFeatureAccess(
  manager: EntityManager,
  featureKey: FeatureKey,
  userIds: string[],
): Promise<string[]> {
  if (isFeatureLaunched(featureKey)) {
    return [...userIds];
  }
  if (!isEarlyAccessFeature(featureKey) || userIds.length === 0) {
    return [];
  }
  const rows: { user_id: string }[] = await manager.query(
    USERS_WITH_EARLY_ACCESS_SQL,
    [userIds, featureKey],
  );
  const grantedUserIds = new Set(rows.map((row) => row.user_id));
  return userIds.filter((userId) => grantedUserIds.has(userId));
}

/**
 * The early-access features `userId` holds a grant for, in registry order.
 * Includes launched ones whose entry still says `earlyAccess: true`; rows for
 * keys the registry no longer knows, or no longer flags, are skipped.
 */
export async function earlyAccessFeaturesForUser(
  manager: EntityManager,
  userId: string,
): Promise<FeatureKey[]> {
  const rows: { feature_key: string }[] = await manager.query(
    EARLY_ACCESS_KEYS_FOR_USER_SQL,
    [userId],
  );
  const grantedKeys = new Set<FeatureKey>(
    rows.map((row) => row.feature_key).filter(isFeatureKey),
  );
  return (Object.keys(launchedFeatures) as FeatureKey[]).filter(
    (featureKey) =>
      grantedKeys.has(featureKey) && isEarlyAccessFeature(featureKey),
  );
}
