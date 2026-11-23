// Batched name marks for roster, post and reply pages: the worn flair and the
// recent-gift mark of each listed member, read in one query per page.
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  COMMUNITY_GIFT_WINDOW_DAYS,
  type CommunityBadgeIconKey,
  type CommunityBadgeStarterKey,
  type CommunityFlairTint,
} from './community-badges.catalog';
import {
  type CommunityNameMarks,
  toCommunityFlairDTO,
} from './community-badge-response';

/** Build the name marks read for the community the given SQL expression
 * names. Flair needs a roster row in a top-level community, a worn badge that
 * is enabled in that community and an award for it; the gift mark needs one
 * gift sent here in the window that is neither removed nor hidden by the
 * recipient. */
function buildNameMarksSql(communityIdExpression: string): string {
  return `
    SELECT "m"."user_id",
           "b"."name" AS "badge_name", "b"."starter_key", "b"."icon_key", "b"."tint",
           ("b"."id" IS NOT NULL AND "a"."id" IS NOT NULL) AS "has_flair",
           EXISTS (SELECT 1 FROM "community_gifts" "g"
             WHERE "g"."community_id" = "m"."community_id" AND "g"."recipient_id" = "m"."user_id"
               AND "g"."removed_at" IS NULL AND "g"."hidden_by_recipient_at" IS NULL
               AND "g"."sent_at" > now() - interval '${COMMUNITY_GIFT_WINDOW_DAYS} days') AS "has_recent_gift"
    FROM "community_members" "m"
    JOIN "communities" "c" ON "c"."id" = "m"."community_id" AND "c"."parent_id" IS NULL
    LEFT JOIN "community_badges" "b" ON "b"."id" = "m"."worn_badge_id" AND "b"."community_id" = "m"."community_id" AND "b"."is_enabled"
    LEFT JOIN "community_badge_awards" "a" ON "a"."badge_id" = "b"."id" AND "a"."user_id" = "m"."user_id"
    WHERE "m"."community_id" = ${communityIdExpression} AND "m"."user_id" = ANY($2::uuid[])
  `;
}

/** Name marks of the listed members in one community. `$1` is the community
 * id, `$2` the user ids. */
export const COMMUNITY_NAME_MARKS_SQL = buildNameMarksSql('$1');

/** Name marks of the listed members in the community that owns a post. `$1`
 * is the post id, `$2` the user ids. A post outside any community matches no
 * roster row. */
export const COMMUNITY_NAME_MARKS_FOR_POST_SQL = buildNameMarksSql(
  '(SELECT "community_id" FROM "community_posts" WHERE "id" = $1)',
);

/** One row of either name marks read. */
interface CommunityNameMarksRow {
  user_id: string;
  badge_name: string | null;
  starter_key: CommunityBadgeStarterKey | null;
  icon_key: CommunityBadgeIconKey | null;
  tint: CommunityFlairTint | null;
  has_flair: boolean;
  has_recent_gift: boolean;
}

/**
 * Reads the flair and the recent-gift mark shown beside member names, one
 * query per page. A member off the roster, in a space, wearing nothing or
 * wearing a disabled or unheld badge maps to `flair: null`; a member with no
 * row in the result is absent from the map, which `nameMarksFor` reads as no
 * marks.
 */
@Injectable()
export class CommunityNameMarksService {
  constructor(private readonly dataSource: DataSource) {}

  /** Marks of the given members in one community. A null community (a
   * global post) or an empty page runs no query. */
  async marksFor(
    communityId: string | null,
    userIds: readonly string[],
  ): Promise<Map<string, CommunityNameMarks>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (communityId === null || uniqueUserIds.length === 0) {
      return new Map();
    }
    const rows: CommunityNameMarksRow[] = await this.dataSource.query(
      COMMUNITY_NAME_MARKS_SQL,
      [communityId, uniqueUserIds],
    );
    return toMarksByUserId(rows);
  }

  /** Marks of the given members in the community that owns the post. An
   * empty page runs no query. */
  async marksForPost(
    postId: string,
    userIds: readonly string[],
  ): Promise<Map<string, CommunityNameMarks>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) {
      return new Map();
    }
    const rows: CommunityNameMarksRow[] = await this.dataSource.query(
      COMMUNITY_NAME_MARKS_FOR_POST_SQL,
      [postId, uniqueUserIds],
    );
    return toMarksByUserId(rows);
  }
}

/** Map the read rows by user id. Flair is built only from a row whose badge
 * join and award join both matched. */
function toMarksByUserId(
  rows: readonly CommunityNameMarksRow[],
): Map<string, CommunityNameMarks> {
  const marksByUserId = new Map<string, CommunityNameMarks>();
  for (const row of rows) {
    const { badge_name: name, icon_key: iconKey, tint } = row;
    const hasFlair =
      row.has_flair === true &&
      name !== null &&
      iconKey !== null &&
      tint !== null;
    marksByUserId.set(row.user_id, {
      flair: hasFlair
        ? toCommunityFlairDTO({
            name,
            starterKey: row.starter_key,
            iconKey,
            tint,
          })
        : null,
      hasRecentGift: row.has_recent_gift === true,
    });
  }
  return marksByUserId;
}
