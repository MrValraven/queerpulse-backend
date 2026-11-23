import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

/** ISO text for a timestamp column, null when the column is empty. */
function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

interface CommunityBadgeExportRow {
  community_id: string;
  community_slug: string;
  community_name: string;
  badge_id: string;
  badge_name: string;
  icon_key: string;
  tint: string;
  rule_type: string;
  threshold: number;
  is_enabled: boolean;
  awarded_at: Date;
  is_worn: boolean;
}

/**
 * `communities` -> `communityBadges`: the badges the member earned in each
 * community, with the badge's look and rule, when it was awarded and whether
 * the member wears it as flair. Raw SQL through the `DataSource`, so
 * `AccountModule` needs no `forFeature` registration.
 */
@Injectable()
export class CommunityBadgesExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityBadges';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: CommunityBadgeExportRow[] = await this.dataSource.query(
      `SELECT "c"."id" AS "community_id",
              "c"."slug" AS "community_slug",
              "c"."name" AS "community_name",
              "b"."id" AS "badge_id",
              "b"."name" AS "badge_name",
              "b"."icon_key" AS "icon_key",
              "b"."tint" AS "tint",
              "b"."rule_type" AS "rule_type",
              "b"."threshold" AS "threshold",
              "b"."is_enabled" AS "is_enabled",
              "a"."awarded_at" AS "awarded_at",
              COALESCE("m"."worn_badge_id" = "b"."id", false) AS "is_worn"
         FROM "community_badge_awards" "a"
        INNER JOIN "community_badges" "b" ON "b"."id" = "a"."badge_id"
        INNER JOIN "communities" "c" ON "c"."id" = "a"."community_id"
         LEFT JOIN "community_members" "m"
           ON "m"."community_id" = "a"."community_id"
          AND "m"."user_id" = "a"."user_id"
        WHERE "a"."user_id" = $1
        ORDER BY "a"."awarded_at" ASC, "a"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      communityId: row.community_id,
      communitySlug: row.community_slug,
      communityName: row.community_name,
      badgeId: row.badge_id,
      badgeName: row.badge_name,
      iconKey: row.icon_key,
      tint: row.tint,
      ruleType: row.rule_type,
      threshold: row.threshold,
      isEnabled: row.is_enabled,
      awardedAt: row.awarded_at.toISOString(),
      isWorn: row.is_worn,
    }));
  }
}

interface CommunityEventsAttendedExportRow {
  community_id: string;
  slug: string;
  name: string;
  events_attended_count: number;
}

/**
 * `communities` -> `communityEventsAttended` (contract section 12): the
 * events attended tally of each roster row the member holds, with the
 * community it belongs to.
 */
@Injectable()
export class CommunityEventsAttendedExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityEventsAttended';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: CommunityEventsAttendedExportRow[] =
      await this.dataSource.query(
        `SELECT "m"."community_id", "c"."slug", "c"."name", "m"."events_attended_count" FROM "community_members" "m" JOIN "communities" "c" ON "c"."id" = "m"."community_id" WHERE "m"."user_id" = $1 ORDER BY "m"."joined_at", "m"."id"`,
        [userId],
      );
    return rows.map((row) => ({
      communityId: row.community_id,
      communitySlug: row.slug,
      communityName: row.name,
      eventsAttended: row.events_attended_count,
    }));
  }
}

interface CommunityGiftReceivedExportRow {
  id: string;
  community_id: string;
  community_slug: string;
  community_name: string;
  gift_key: string;
  note: string | null;
  sender_name: string | null;
  sent_at: Date;
  hidden_at: Date | null;
  removed_at: Date | null;
}

/**
 * `communities` -> `communityGiftsReceived`: the gifts staff sent the member,
 * with the sender's name (null once the sender's account is erased), the
 * note, and the dates the member hid it or staff removed it.
 */
@Injectable()
export class CommunityGiftsReceivedExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityGiftsReceived';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: CommunityGiftReceivedExportRow[] = await this.dataSource.query(
      `SELECT "g"."id" AS "id",
              "c"."id" AS "community_id",
              "c"."slug" AS "community_slug",
              "c"."name" AS "community_name",
              "g"."gift_key" AS "gift_key",
              "g"."note" AS "note",
              NULLIF(btrim(concat_ws(' ', "p"."first_name", "p"."last_name")), '') AS "sender_name",
              "g"."sent_at" AS "sent_at",
              "g"."hidden_by_recipient_at" AS "hidden_at",
              "g"."removed_at" AS "removed_at"
         FROM "community_gifts" "g"
        INNER JOIN "communities" "c" ON "c"."id" = "g"."community_id"
         LEFT JOIN "profiles" "p" ON "p"."user_id" = "g"."sender_id"
        WHERE "g"."recipient_id" = $1
        ORDER BY "g"."sent_at" ASC, "g"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      communitySlug: row.community_slug,
      communityName: row.community_name,
      giftKey: row.gift_key,
      note: row.note,
      senderName: row.sender_name,
      sentAt: row.sent_at.toISOString(),
      hiddenAt: toIsoOrNull(row.hidden_at),
      removedAt: toIsoOrNull(row.removed_at),
    }));
  }
}

interface CommunityGiftSentExportRow {
  id: string;
  community_id: string;
  community_slug: string;
  community_name: string;
  gift_key: string;
  note: string | null;
  sent_at: Date;
  removed_at: Date | null;
}

/**
 * `communities` -> `communityGiftsSent`: the gifts the member sent as
 * community staff, with the note and when each was sent or removed. The
 * recipient is left out of the rows.
 */
@Injectable()
export class CommunityGiftsSentExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityGiftsSent';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: CommunityGiftSentExportRow[] = await this.dataSource.query(
      `SELECT "g"."id" AS "id",
              "c"."id" AS "community_id",
              "c"."slug" AS "community_slug",
              "c"."name" AS "community_name",
              "g"."gift_key" AS "gift_key",
              "g"."note" AS "note",
              "g"."sent_at" AS "sent_at",
              "g"."removed_at" AS "removed_at"
         FROM "community_gifts" "g"
        INNER JOIN "communities" "c" ON "c"."id" = "g"."community_id"
        WHERE "g"."sender_id" = $1
        ORDER BY "g"."sent_at" ASC, "g"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      communitySlug: row.community_slug,
      communityName: row.community_name,
      giftKey: row.gift_key,
      note: row.note,
      sentAt: row.sent_at.toISOString(),
      removedAt: toIsoOrNull(row.removed_at),
    }));
  }
}
