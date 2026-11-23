import type { EntityManager } from 'typeorm';
import { COMMUNITY_BADGE_STARTERS } from './community-badges.catalog';

/**
 * Inserts the starter badges of one community from parallel arrays, in
 * catalogue order. Parameters: `[communityId, starterKeys, names, iconKeys,
 * tints, ruleTypes, thresholds, positions]`. Each starter's `created_at` is
 * offset by its position in milliseconds so the list order follows the
 * catalogue. `backfill_requested_at` is set, so history is awarded silently by
 * the backfill job. A repeat run inserts nothing.
 */
export const COMMUNITY_BADGE_STARTER_INSERT_SQL = `INSERT INTO "community_badges" ("community_id", "starter_key", "name", "icon_key", "tint", "rule_type", "threshold", "is_enabled", "created_by_id", "backfill_requested_at", "created_at", "updated_at")
SELECT $1::uuid, "starter"."starter_key", "starter"."name", "starter"."icon_key", "starter"."tint",
       "starter"."rule_type"::"community_badges_rule_type_enum", "starter"."threshold", true, NULL, now(),
       now() + ("starter"."position" * interval '1 millisecond'), now() + ("starter"."position" * interval '1 millisecond')
FROM unnest($2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[], $6::varchar[], $7::int[], $8::int[])
  AS "starter"("starter_key", "name", "icon_key", "tint", "rule_type", "threshold", "position")
ON CONFLICT DO NOTHING`;

/**
 * Seeds the four starter badges into a newly created top-level community in
 * one statement. Called on top-level creation only; spaces are never seeded.
 */
export async function seedCommunityBadgeStarters(
  manager: Pick<EntityManager, 'query'>,
  communityId: string,
): Promise<void> {
  await manager.query(COMMUNITY_BADGE_STARTER_INSERT_SQL, [
    communityId,
    COMMUNITY_BADGE_STARTERS.map((starter) => starter.starterKey),
    COMMUNITY_BADGE_STARTERS.map((starter) => starter.name),
    COMMUNITY_BADGE_STARTERS.map((starter) => starter.iconKey),
    COMMUNITY_BADGE_STARTERS.map((starter) => starter.tint),
    COMMUNITY_BADGE_STARTERS.map((starter) => starter.ruleType),
    COMMUNITY_BADGE_STARTERS.map((starter) => starter.threshold),
    COMMUNITY_BADGE_STARTERS.map((_starter, position) => position),
  ]);
}
