import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SavedKind } from '../saved/entities/saved-item.entity';
import { SavedService } from '../saved/saved.service';
import {
  STUDIO_RELEASE_PUBLISHED,
  StudioReleasePublishedEvent,
} from './studio.events';
import { listenablePersonaSql } from './studio-visibility';
import { STUDIO_LIMITS } from './studio.constants';

/** The row the claim returns: everything the payload, the filter and the
 *  pre-save need. `reminder_user_ids` are the reminder rows the claim
 *  consumed. */
export interface ClaimedReleaseRow {
  release_id: string;
  release_title: string;
  release_type: string;
  subprofile_id: string;
  subprofile_name: string;
  subprofile_slug_or_handle: string;
  owner_user_id: string;
  reminder_user_ids: string[];
}

interface RecipientRow {
  recipient_id: string;
  is_reminder_holder: boolean;
}

/**
 * Claims a release for its one alert and, in the same statement, consumes
 * its Notify me reminders (Studio v3): the reminder rows go only when the
 * claim succeeds, so a second claim (a repeated event, the cron racing a
 * manual publish) finds neither a release to claim nor reminders to read.
 * Wrapped in `WITH ... SELECT` so `DataSource.query` returns plain rows.
 *
 * The link token is the handle with the slug behind it, the same
 * `handle ?? slug` the persona update alert sends. The name falls back to
 * that token when the display name is blank (a create stores it untrimmed),
 * so the payload always carries a name the push can print. The publish rule
 * already requires a non-blank title.
 */
export const RELEASE_ALERT_CLAIM_SQL = `WITH "claimed" AS (
  UPDATE "studio_releases" AS "release"
     SET "followers_notified_at" = now()
    FROM "subprofiles" "persona"
   WHERE "release"."id" = $1
     AND "release"."followers_notified_at" IS NULL
     AND "release"."status" = 'published'
     AND "persona"."id" = "release"."subprofile_id"
     AND ${listenablePersonaSql('persona')}
  RETURNING "release"."id" AS "release_id",
            "release"."title" AS "release_title",
            "release"."type"::text AS "release_type",
            "persona"."id" AS "subprofile_id",
            COALESCE(
              NULLIF(btrim("persona"."display_name"), ''),
              "persona"."handle",
              "persona"."slug"
            ) AS "subprofile_name",
            COALESCE("persona"."handle", "persona"."slug") AS "subprofile_slug_or_handle",
            "persona"."user_id" AS "owner_user_id"
), "consumed_reminders" AS (
  DELETE FROM "studio_release_reminders" AS "reminder"
   USING "claimed"
   WHERE "reminder"."release_id" = "claimed"."release_id"
  RETURNING "reminder"."user_id" AS "user_id"
)
SELECT "claimed".*,
       ARRAY(SELECT "consumed_reminders"."user_id"::text FROM "consumed_reminders") AS "reminder_user_ids"
  FROM "claimed"`;

/**
 * Studio v3: runs only when neither the claim nor the later-drop consume
 * found the release, so it is unpublished or its persona is not listenable.
 * A published release's reminders then have nothing left to wait for; a
 * scheduled or draft release keeps them.
 */
export const RELEASE_REMINDERS_DISCARD_SQL = `DELETE FROM "studio_release_reminders" AS "reminder"
 USING "studio_releases" AS "release"
 WHERE "reminder"."release_id" = $1
   AND "release"."id" = "reminder"."release_id"
   AND "release"."status" = 'published'`;

/** A recipient is someone other than the creator (`creatorIdSql`, $2 by
 *  default) and the persona's co-owners (`personaIdSql`, $1 by default) who
 *  holds a Studio grant. */
function eligibleRecipientSql(
  userIdColumn: string,
  personaIdSql = '$1',
  creatorIdSql = '$2',
): string {
  return `${userIdColumn} <> ${creatorIdSql}
     AND NOT EXISTS (
       SELECT 1 FROM "subprofile_members" "persona_member"
        WHERE "persona_member"."subprofile_id" = ${personaIdSql}
          AND "persona_member"."user_id" = ${userIdColumn}
     )
     AND EXISTS (
       SELECT 1 FROM "studio_access_grants" "recipient_grant"
        WHERE "recipient_grant"."user_id" = ${userIdColumn}
     )`;
}

/** Studio v3: a reminder holder blocked either way with the creator
 *  (`creatorIdSql`, $2 by default) is left out, read from the `blocks`
 *  table `BlockFilterService.excludeBlocked` reads. */
function notBlockedWithCreatorSql(
  userIdColumn: string,
  creatorIdSql = '$2',
): string {
  return `NOT EXISTS (
       SELECT 1 FROM "blocks" "creator_block"
        WHERE ("creator_block"."blocker_id" = ${creatorIdSql} AND "creator_block"."blocked_id" = ${userIdColumn})
           OR ("creator_block"."blocked_id" = ${creatorIdSql} AND "creator_block"."blocker_id" = ${userIdColumn})
     )`;
}

/**
 * Who hears about the release: the persona's followers (the oldest $3
 * follows) and, Studio v3, the members whose reminders the claim consumed
 * ($4), each list filtered by `eligibleRecipientSql` and capped at $3, then
 * deduplicated and ordered by member id. `is_reminder_holder` marks who gets
 * the pre-save. A reminder holder blocked either way with the creator ($2)
 * is left out here (`notBlockedWithCreatorSql`), so they get no pre-save;
 * the alert itself is block-filtered inside
 * `NotificationsService.createForRecipients` for everyone.
 */
export const RELEASE_ALERT_RECIPIENTS_SQL = `WITH "eligible_followers" AS (
  SELECT "follower"."follower_id" AS "user_id"
    FROM "subprofile_followers" "follower"
   WHERE "follower"."subprofile_id" = $1
     AND ${eligibleRecipientSql('"follower"."follower_id"')}
   ORDER BY "follower"."created_at" ASC, "follower"."id" ASC
   LIMIT $3
), "eligible_reminder_holders" AS (
  SELECT DISTINCT "reminder_holder"."user_id" AS "user_id"
    FROM unnest($4::uuid[]) AS "reminder_holder"("user_id")
   WHERE ${eligibleRecipientSql('"reminder_holder"."user_id"')}
     AND ${notBlockedWithCreatorSql('"reminder_holder"."user_id"')}
   LIMIT $3
)
SELECT "candidate"."user_id"::text AS "recipient_id",
       bool_or("candidate"."is_reminder_holder") AS "is_reminder_holder"
  FROM (
    SELECT "user_id", false AS "is_reminder_holder" FROM "eligible_followers"
    UNION ALL
    SELECT "user_id", true AS "is_reminder_holder" FROM "eligible_reminder_holders"
  ) "candidate"
 GROUP BY "candidate"."user_id"
 ORDER BY "candidate"."user_id"`;

/**
 * Studio v3, a later drop: the release is published again after an earlier
 * publish already alerted its followers (`followers_notified_at` set), so
 * the claim finds nothing. Reminder holders are honoured on every drop and
 * followers on the first publish alone, so this consumes the release's
 * reminders in one statement while the release is published and its persona
 * listenable (the claim's predicate), and answers the claim's row shape with
 * `reminder_user_ids` already filtered as the recipient read filters reminder
 * holders (grant holders, minus the creator, the co-owners and anyone
 * blocked either way with the creator), ordered by member id and capped at
 * $2. Each reminder row is consumed once, so a repeated event finds no row.
 * No row either when the release is not published or not listenable; the
 * listener then runs `RELEASE_REMINDERS_DISCARD_SQL`.
 */
export const RELEASE_LATER_DROP_REMINDERS_SQL = `WITH "dropped" AS (
  SELECT "release"."id" AS "release_id",
         "release"."title" AS "release_title",
         "release"."type"::text AS "release_type",
         "persona"."id" AS "subprofile_id",
         COALESCE(
           NULLIF(btrim("persona"."display_name"), ''),
           "persona"."handle",
           "persona"."slug"
         ) AS "subprofile_name",
         COALESCE("persona"."handle", "persona"."slug") AS "subprofile_slug_or_handle",
         "persona"."user_id" AS "owner_user_id"
    FROM "studio_releases" "release"
    JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
   WHERE "release"."id" = $1
     AND "release"."status" = 'published'
     AND ${listenablePersonaSql('persona')}
), "consumed" AS (
  DELETE FROM "studio_release_reminders" AS "reminder"
   USING "dropped"
   WHERE "reminder"."release_id" = "dropped"."release_id"
  RETURNING "reminder"."user_id" AS "user_id"
)
SELECT "dropped".*,
       ARRAY(
         SELECT "reminder_holder"."user_id"::text
           FROM "consumed" AS "reminder_holder"
          WHERE ${eligibleRecipientSql('"reminder_holder"."user_id"', '"dropped"."subprofile_id"', '"dropped"."owner_user_id"')}
            AND ${notBlockedWithCreatorSql('"reminder_holder"."user_id"', '"dropped"."owner_user_id"')}
          ORDER BY "reminder_holder"."user_id"
          LIMIT $2
       ) AS "reminder_user_ids"
  FROM "dropped"
 WHERE EXISTS (SELECT 1 FROM "consumed")`;

/**
 * Studio v2: "a persona you follow put out a release", the follower half of
 * following an artist. Studio v3 adds the members who pressed Notify me on
 * the scheduled release: they hear once with the followers and find the
 * release in their Saved. Followers hear on the first publish alone; on a
 * later drop (published again after an unpublish) the reminder holders hear
 * by themselves (`RELEASE_LATER_DROP_REMINDERS_SQL`).
 *
 * Shaped like `SubprofileUpdatesService.notifyFollowersOfNewItems`: a
 * bounded recipient read ordered by member id (so the chunks split by id,
 * each list having kept its own cap first), chunks of 500 handed to
 * `NotificationsService.createForRecipients` (one multi-row insert each,
 * with the block, mute and `persona_follows` preference filters batched
 * inside it), three chunks in flight through `runWithConcurrency`, and push
 * riding each chunk's batch event. The persona owner's id goes to
 * `createForRecipients` for block and mute filtering only; the payload names
 * the persona.
 *
 * Best effort and post-commit: the publish has already happened, so nothing
 * here throws back at it, and a failed fan-out still lets the pre-save run.
 */
@Injectable()
export class StudioReleaseAlertsListener {
  private readonly logger = new Logger(StudioReleaseAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly saved: SavedService,
  ) {}

  @OnEvent(STUDIO_RELEASE_PUBLISHED)
  async handleReleasePublished(
    event: StudioReleasePublishedEvent,
  ): Promise<void> {
    const claim = await this.claimRelease(event.releaseId);
    if (!claim) {
      return;
    }
    await this.sendAlerts(claim.claimed, claim.recipientRows);
    await this.preSave(claim.claimed, claim.recipientRows);
  }

  /** The claim and the recipient read, or a later drop's reminder holders
   *  alone, or null when there is nobody to tell (nothing claimed or
   *  consumed, or a read failed). */
  private async claimRelease(releaseId: string): Promise<{
    claimed: ClaimedReleaseRow;
    recipientRows: RecipientRow[];
  } | null> {
    try {
      const claimedRows: ClaimedReleaseRow[] = await this.dataSource.query(
        RELEASE_ALERT_CLAIM_SQL,
        [releaseId],
      );
      const claimed = claimedRows[0];
      if (!claimed) {
        return await this.consumeLaterDrop(releaseId);
      }
      const recipientRows: RecipientRow[] = await this.dataSource.query(
        RELEASE_ALERT_RECIPIENTS_SQL,
        [
          claimed.subprofile_id,
          claimed.owner_user_id,
          STUDIO_LIMITS.followerAlertMaxRecipients,
          claimed.reminder_user_ids,
        ],
      );
      return { claimed, recipientRows };
    } catch (error) {
      this.logger.warn(
        `New-release alert failed for ${releaseId}: ${String(error)}`,
      );
      return null;
    }
  }

  /** Studio v3: the followers heard at the first publish; on a later drop
   *  only the members who pressed Notify me hear, and get the pre-save.
   *  Runs inside `claimRelease`'s try. */
  private async consumeLaterDrop(releaseId: string): Promise<{
    claimed: ClaimedReleaseRow;
    recipientRows: RecipientRow[];
  } | null> {
    const droppedRows: ClaimedReleaseRow[] = await this.dataSource.query(
      RELEASE_LATER_DROP_REMINDERS_SQL,
      [releaseId, STUDIO_LIMITS.followerAlertMaxRecipients],
    );
    const dropped = droppedRows[0];
    if (!dropped) {
      await this.dataSource.query(RELEASE_REMINDERS_DISCARD_SQL, [releaseId]);
      return null;
    }
    return {
      claimed: dropped,
      recipientRows: dropped.reminder_user_ids.map((reminderHolderId) => ({
        recipient_id: reminderHolderId,
        is_reminder_holder: true,
      })),
    };
  }

  private async sendAlerts(
    claimed: ClaimedReleaseRow,
    recipientRows: RecipientRow[],
  ): Promise<void> {
    const recipientIds = recipientRows.map((row) => row.recipient_id);
    if (!recipientIds.length) {
      return;
    }
    const payload = {
      subprofileName: claimed.subprofile_name,
      subprofileSlugOrHandle: claimed.subprofile_slug_or_handle,
      subprofileId: claimed.subprofile_id,
      releaseId: claimed.release_id,
      releaseTitle: claimed.release_title,
      releaseType: claimed.release_type,
    };
    const chunkSize = STUDIO_LIMITS.followerAlertChunkSize;
    const chunkThunks: Array<() => Promise<string[]>> = [];
    for (let offset = 0; offset < recipientIds.length; offset += chunkSize) {
      const chunk = recipientIds.slice(offset, offset + chunkSize);
      // A thunk, so `runWithConcurrency` decides when each chunk claims
      // its pool connection.
      chunkThunks.push(() =>
        this.notifications.createForRecipients(
          chunk,
          NotificationType.StudioReleasePublished,
          payload,
          claimed.owner_user_id,
        ),
      );
    }
    try {
      await runWithConcurrency(
        chunkThunks,
        STUDIO_LIMITS.followerAlertConcurrentChunks,
      );
    } catch (error) {
      this.logger.warn(
        `New-release alert failed for ${claimed.release_id}: ${String(error)}`,
      );
    }
  }

  /** Studio v3: the release lands in every eligible reminder holder's
   *  Saved, with the snapshot the album page's own Save sends. */
  private async preSave(
    claimed: ClaimedReleaseRow,
    recipientRows: RecipientRow[],
  ): Promise<void> {
    const reminderHolderIds = recipientRows
      .filter((row) => row.is_reminder_holder)
      .map((row) => row.recipient_id);
    if (!reminderHolderIds.length) {
      return;
    }
    try {
      await this.saved.saveForMembersIfMissing(
        reminderHolderIds,
        SavedKind.StudioRelease,
        claimed.release_id,
        {
          title: claimed.release_title,
          href: `/studio/album?id=${claimed.release_id}`,
          meta: claimed.subprofile_name,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Pre-save failed for ${claimed.release_id}: ${String(error)}`,
      );
    }
  }
}
