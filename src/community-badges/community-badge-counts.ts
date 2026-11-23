import { CommunityBadgeRuleType } from './community-badges.catalog';

/** One member's four badge counts in one top-level community. */
export interface CommunityMemberBadgeCounts {
  tenureDays: number;
  eventsCheckedIn: number;
  volunteerHours: number;
  postsAndReplies: number;
}

/** The count a rule reads from a member's counts. */
export function progressForRule(
  counts: CommunityMemberBadgeCounts,
  ruleType: CommunityBadgeRuleType,
): number {
  switch (ruleType) {
    case CommunityBadgeRuleType.TenureDays:
      return counts.tenureDays;
    case CommunityBadgeRuleType.EventsCheckedIn:
      return counts.eventsCheckedIn;
    case CommunityBadgeRuleType.VolunteerHours:
      return counts.volunteerHours;
    case CommunityBadgeRuleType.PostsAndReplies:
      return counts.postsAndReplies;
  }
}

/**
 * The shared counts CTE, read by progress and by the award insert alike.
 * Parameters: `$1` the community id, `$2` one user id or NULL for the whole
 * roster. The roster joins `communities` on `parent_id IS NULL`, so a space
 * counts nothing. Events read the attendance tally on the roster row (it
 * outlives the 30-day erasure of `checked_in_at`). Volunteer hours sum
 * completed signups of this community's opportunities, floored to whole hours.
 * Posts and replies drop tombstones and anything a moderator removed under
 * the `post` or `reply` subject codes; hidden-only content still counts.
 * Ends at the `member_counts` CTE, so a caller appends its own statement.
 */
export const COMMUNITY_MEMBER_COUNTS_CTE = `WITH "roster" AS (
  SELECT "m"."user_id", "m"."joined_at", "m"."events_attended_count"
  FROM "community_members" "m"
  JOIN "communities" "c" ON "c"."id" = "m"."community_id" AND "c"."parent_id" IS NULL
  WHERE "m"."community_id" = $1 AND ($2::uuid IS NULL OR "m"."user_id" = $2::uuid)
),
"volunteered" AS (
  SELECT "s"."user_id", floor(sum("s"."hours_contributed"))::int AS "total"
  FROM "volunteer_signups" "s" JOIN "volunteer_opportunities" "o" ON "o"."id" = "s"."opportunity_id"
  WHERE "o"."community_id" = $1 AND "s"."completed_at" IS NOT NULL
    AND "s"."user_id" IN (SELECT "user_id" FROM "roster")
  GROUP BY "s"."user_id"
),
"posted" AS (
  SELECT "p"."author_id" AS "user_id", count(*)::int AS "total"
  FROM "community_posts" "p"
  WHERE "p"."community_id" = $1 AND "p"."deleted_at" IS NULL
    AND "p"."author_id" IN (SELECT "user_id" FROM "roster")
    AND NOT EXISTS (SELECT 1 FROM "content_moderation" "cm"
      WHERE "cm"."subject_type" IN ('post', 'reply') AND "cm"."subject_id" = "p"."id"::text AND "cm"."removed_at" IS NOT NULL)
  GROUP BY "p"."author_id"
),
"replied" AS (
  SELECT "rp"."author_id" AS "user_id", count(*)::int AS "total"
  FROM "community_post_replies" "rp" JOIN "community_posts" "p" ON "p"."id" = "rp"."post_id"
  WHERE "p"."community_id" = $1 AND "rp"."deleted_at" IS NULL
    AND "rp"."author_id" IN (SELECT "user_id" FROM "roster")
    AND NOT EXISTS (SELECT 1 FROM "content_moderation" "cm"
      WHERE "cm"."subject_type" IN ('post', 'reply') AND "cm"."subject_id" = "rp"."id"::text AND "cm"."removed_at" IS NOT NULL)
  GROUP BY "rp"."author_id"
),
"member_counts" AS (
  SELECT "roster"."user_id",
    floor(extract(epoch FROM (now() - "roster"."joined_at")) / 86400)::int AS "tenure_days",
    "roster"."events_attended_count" AS "events_checked_in",
    coalesce("volunteered"."total", 0) AS "volunteer_hours",
    coalesce("posted"."total", 0) + coalesce("replied"."total", 0) AS "posts_and_replies"
  FROM "roster"
  LEFT JOIN "volunteered" USING ("user_id")
  LEFT JOIN "posted" USING ("user_id") LEFT JOIN "replied" USING ("user_id")
)`;

/** One member's counts row. Parameters: `[communityId, userId]`. */
export const MEMBER_BADGE_COUNTS_SQL =
  COMMUNITY_MEMBER_COUNTS_CTE +
  ' SELECT "tenure_days", "events_checked_in", "volunteer_hours", "posts_and_replies" FROM "member_counts"';

/**
 * Inserts an award for every roster member whose count meets an enabled
 * badge's threshold, and returns the new rows. Parameters:
 * `[communityId, userId | null, badgeIds | null, onlyReadyBadges]`; a null
 * user id reads the whole roster, a null badge list reads every enabled badge,
 * and `onlyReadyBadges` skips badges whose backfill is still pending. The
 * unique pair `(badge_id, user_id)` makes a repeat run insert nothing. Wrapped
 * in `WITH ... SELECT` so the driver returns the inserted rows.
 */
export const AWARD_QUALIFYING_MEMBERS_SQL = `${COMMUNITY_MEMBER_COUNTS_CTE},
"inserted" AS (
  INSERT INTO "community_badge_awards" ("badge_id", "community_id", "user_id")
  SELECT "b"."id", "b"."community_id", "mc"."user_id"
  FROM "community_badges" "b"
  JOIN "member_counts" "mc" ON (CASE "b"."rule_type"
      WHEN 'tenure_days' THEN "mc"."tenure_days"
      WHEN 'events_checked_in' THEN "mc"."events_checked_in"
      WHEN 'volunteer_hours' THEN "mc"."volunteer_hours"
      WHEN 'posts_and_replies' THEN "mc"."posts_and_replies" END) >= "b"."threshold"
  WHERE "b"."community_id" = $1 AND "b"."is_enabled"
    AND ($3::uuid[] IS NULL OR "b"."id" = ANY($3::uuid[]))
    AND (NOT $4::boolean OR "b"."backfill_requested_at" IS NULL)
  ON CONFLICT ("badge_id", "user_id") DO NOTHING
  RETURNING "id", "badge_id", "user_id"
)
SELECT "id", "badge_id", "user_id" FROM "inserted"`;

/**
 * Marks one badge's awards as notified for the recipients the bell accepted.
 * Parameters: `[badgeId, userIds]`.
 */
export const MARK_AWARDS_NOTIFIED_SQL = `UPDATE "community_badge_awards" SET "is_notified" = true WHERE "badge_id" = $1 AND "user_id" = ANY($2::uuid[])`;
