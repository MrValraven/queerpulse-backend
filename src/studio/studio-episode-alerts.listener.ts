import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { RELEASE_ALERT_RECIPIENTS_SQL } from './studio-release-alerts.listener';
import { listenablePersonaSql } from './studio-visibility';
import { STUDIO_LIMITS } from './studio.constants';
import {
  STUDIO_EPISODE_PUBLISHED,
  StudioEpisodePublishedEvent,
} from './studio.events';

/** The row the claim returns: everything the payload and the filter need. */
export interface ClaimedEpisodeRow {
  track_id: string;
  track_title: string;
  release_id: string;
  release_title: string;
  subprofile_id: string;
  subprofile_name: string;
  subprofile_slug_or_handle: string;
  owner_user_id: string;
}

interface RecipientRow {
  recipient_id: string;
  is_reminder_holder: boolean;
}

/**
 * Claims an episode for its one alert: a published episode with confirmed
 * audio, of a published show, of a listenable persona, still unclaimed.
 * A show publish stamps the claim on every episode it carries, so only
 * `POST /studio/tracks/:id/publish` leaves one to claim. Every stamp is the
 * publish moment or a past drop time, so the claim needs no clock check
 * (the listener reads keep `published_at <= now()` as a guard). Wrapped in
 * `WITH ... SELECT` so `DataSource.query` returns plain rows. The name and
 * link token follow `RELEASE_ALERT_CLAIM_SQL`: the handle with the slug
 * behind it, and that token when the display name is blank.
 */
export const EPISODE_ALERT_CLAIM_SQL = `WITH "claimed" AS (
  UPDATE "studio_tracks" AS "episode"
     SET "followers_notified_at" = now()
    FROM "studio_releases" "release", "subprofiles" "persona"
   WHERE "episode"."id" = $1
     AND "episode"."followers_notified_at" IS NULL
     AND "episode"."published_at" IS NOT NULL
     AND "episode"."audio_key" IS NOT NULL
     AND "episode"."duration_seconds" IS NOT NULL
     AND "release"."id" = "episode"."release_id"
     AND "release"."status" = 'published'
     AND "release"."type" = 'podcast'
     AND "persona"."id" = "release"."subprofile_id"
     AND ${listenablePersonaSql('persona')}
  RETURNING "episode"."id" AS "track_id",
            "episode"."title" AS "track_title",
            "release"."id" AS "release_id",
            "release"."title" AS "release_title",
            "persona"."id" AS "subprofile_id",
            COALESCE(
              NULLIF(btrim("persona"."display_name"), ''),
              "persona"."handle",
              "persona"."slug"
            ) AS "subprofile_name",
            COALESCE("persona"."handle", "persona"."slug") AS "subprofile_slug_or_handle",
            "persona"."user_id" AS "owner_user_id"
)
SELECT "claimed".* FROM "claimed"`;

/**
 * Studio artist kinds: "a show you follow published an episode". Shaped
 * like `StudioReleaseAlertsListener`: the same recipient read (followers
 * holding a Studio grant, minus the persona's creator and co-owners, capped
 * at 5000) with no reminder holders, chunks of 500 handed to
 * `NotificationsService.createForRecipients` (block, mute and the
 * `persona_follows` preference filtered inside it), three chunks in flight,
 * push riding each chunk's batch event. The persona owner's id goes to
 * `createForRecipients` for block and mute filtering only; the payload names
 * the persona, the show and the episode.
 *
 * Best effort and post-commit: the episode is already out, so nothing here
 * throws back at the publish.
 */
@Injectable()
export class StudioEpisodeAlertsListener {
  private readonly logger = new Logger(StudioEpisodeAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_EPISODE_PUBLISHED)
  async handleEpisodePublished(
    event: StudioEpisodePublishedEvent,
  ): Promise<void> {
    const claim = await this.claimEpisode(event.trackId);
    if (!claim || !claim.recipientIds.length) {
      return;
    }
    await this.sendAlerts(claim.claimed, claim.recipientIds);
  }

  /** The claim and the recipient read, or null when there is nobody to
   *  tell (nothing claimed, or a read failed). */
  private async claimEpisode(trackId: string): Promise<{
    claimed: ClaimedEpisodeRow;
    recipientIds: string[];
  } | null> {
    try {
      const claimedRows: ClaimedEpisodeRow[] = await this.dataSource.query(
        EPISODE_ALERT_CLAIM_SQL,
        [trackId],
      );
      const claimed = claimedRows[0];
      if (!claimed) {
        return null;
      }
      const recipientRows: RecipientRow[] = await this.dataSource.query(
        RELEASE_ALERT_RECIPIENTS_SQL,
        [
          claimed.subprofile_id,
          claimed.owner_user_id,
          STUDIO_LIMITS.followerAlertMaxRecipients,
          [],
        ],
      );
      return {
        claimed,
        recipientIds: recipientRows.map((row) => row.recipient_id),
      };
    } catch (error) {
      this.logger.warn(
        `New-episode alert failed for ${trackId}: ${String(error)}`,
      );
      return null;
    }
  }

  private async sendAlerts(
    claimed: ClaimedEpisodeRow,
    recipientIds: string[],
  ): Promise<void> {
    const payload = {
      subprofileName: claimed.subprofile_name,
      subprofileSlugOrHandle: claimed.subprofile_slug_or_handle,
      subprofileId: claimed.subprofile_id,
      releaseId: claimed.release_id,
      trackId: claimed.track_id,
      releaseTitle: claimed.release_title,
      trackTitle: claimed.track_title,
    };
    const chunkSize = STUDIO_LIMITS.followerAlertChunkSize;
    const chunkThunks: Array<() => Promise<string[]>> = [];
    for (let offset = 0; offset < recipientIds.length; offset += chunkSize) {
      const chunk = recipientIds.slice(offset, offset + chunkSize);
      // A thunk, so `runWithConcurrency` decides when each chunk claims its
      // pool connection.
      chunkThunks.push(() =>
        this.notifications.createForRecipients(
          chunk,
          NotificationType.StudioEpisodePublished,
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
        `New-episode alert failed for ${claimed.track_id}: ${String(error)}`,
      );
    }
  }
}
