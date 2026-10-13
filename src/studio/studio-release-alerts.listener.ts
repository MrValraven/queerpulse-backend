import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  STUDIO_RELEASE_PUBLISHED,
  StudioReleasePublishedEvent,
} from './studio.events';
import { listenablePersonaSql } from './studio-visibility';
import { STUDIO_LIMITS } from './studio.constants';

/** The row the claim returns: everything the payload and the filter need. */
export interface ClaimedReleaseRow {
  release_id: string;
  release_title: string;
  release_type: string;
  subprofile_id: string;
  subprofile_name: string;
  subprofile_slug_or_handle: string;
  owner_user_id: string;
}

interface FollowerRow {
  follower_id: string;
}

/**
 * Claims a release for its one alert. Wrapped in `WITH ... SELECT` so
 * `DataSource.query` returns plain rows; a bare `UPDATE ... RETURNING`
 * comes back as `[rows, rowCount]`.
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
)
SELECT * FROM "claimed"`;

/**
 * The persona's followers who hold a Studio grant, minus its creator ($2)
 * and every co-owner, oldest follow first, bounded by $3. One indexed read
 * (`subprofile_followers` by persona) with two semi-joins.
 */
export const RELEASE_ALERT_RECIPIENTS_SQL = `SELECT "follower"."follower_id" AS "follower_id"
  FROM "subprofile_followers" "follower"
 WHERE "follower"."subprofile_id" = $1
   AND "follower"."follower_id" <> $2
   AND NOT EXISTS (
     SELECT 1 FROM "subprofile_members" "persona_member"
      WHERE "persona_member"."subprofile_id" = $1
        AND "persona_member"."user_id" = "follower"."follower_id"
   )
   AND EXISTS (
     SELECT 1 FROM "studio_access_grants" "follower_grant"
      WHERE "follower_grant"."user_id" = "follower"."follower_id"
   )
 ORDER BY "follower"."created_at" ASC, "follower"."id" ASC
 LIMIT $3`;

/**
 * Studio v2: "a persona you follow put out a release", the follower half of
 * following an artist. Shaped like `SubprofileUpdatesService
 * .notifyFollowersOfNewItems`: a bounded follower read, chunks of 500 handed
 * to `NotificationsService.createForRecipients` (one multi-row insert each,
 * with the block, mute and `persona_follows` preference filters batched
 * inside it), three chunks in flight through `runWithConcurrency`, and push
 * riding each chunk's batch event. The persona owner's id goes to
 * `createForRecipients` for block and mute filtering only; the payload names
 * the persona.
 *
 * Best effort and post-commit: the publish has already happened, so nothing
 * here throws back at it.
 */
@Injectable()
export class StudioReleaseAlertsListener {
  private readonly logger = new Logger(StudioReleaseAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_RELEASE_PUBLISHED)
  async handleReleasePublished(
    event: StudioReleasePublishedEvent,
  ): Promise<void> {
    try {
      const claimedRows: ClaimedReleaseRow[] = await this.dataSource.query(
        RELEASE_ALERT_CLAIM_SQL,
        [event.releaseId],
      );
      const claimed = claimedRows[0];
      if (!claimed) {
        return;
      }
      const followerRows: FollowerRow[] = await this.dataSource.query(
        RELEASE_ALERT_RECIPIENTS_SQL,
        [
          claimed.subprofile_id,
          claimed.owner_user_id,
          STUDIO_LIMITS.followerAlertMaxRecipients,
        ],
      );
      const recipientIds = followerRows.map((row) => row.follower_id);
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
      await runWithConcurrency(
        chunkThunks,
        STUDIO_LIMITS.followerAlertConcurrentChunks,
      );
    } catch (error) {
      this.logger.warn(
        `New-release alert failed for ${event.releaseId}: ${String(error)}`,
      );
    }
  }
}
