import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';

/** One owner of the track's persona, with the track title and release id. */
interface TrackNoticeRow {
  track_title: string;
  release_id: string;
  user_id: string;
}

export type StudioClaimOutcome = 'upheld' | 'rejected';
export type StudioTrackMarkChange = 'explicit' | 'content_warning';

/**
 * The track's owners at send time: the persona's creator and every member
 * of its roster, each once (`UNION` drops the creator's own roster row), in
 * user id order, with the track title and release id. A track that is gone
 * returns no row. The `RELEASE_NOTICE_RECIPIENTS_SQL` rule, keyed by track.
 */
export const TRACK_NOTICE_SQL = `SELECT "track"."title" AS "track_title",
       "track"."release_id" AS "release_id",
       "owner"."user_id" AS "user_id"
  FROM "studio_tracks" "track"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 INNER JOIN LATERAL (
   SELECT "persona"."user_id" AS "user_id"
    UNION
   SELECT "persona_member"."user_id" AS "user_id"
     FROM "subprofile_members" "persona_member"
    WHERE "persona_member"."subprofile_id" = "persona"."id"
 ) "owner" ON true
 WHERE "track"."id" = $1
 ORDER BY "owner"."user_id"`;

/**
 * Studio safety and moderation: the six in-app claim and track notices.
 * Always delivered, in-app only (no type is on the push whitelist), no
 * actor: neither `create` nor `createForRecipients` gets an actor id, so no
 * block or mute between a member and staff can swallow one, and no payload
 * names a member. Owner payloads carry the claim, track and release ids and
 * the title; claimant payloads carry the claim id and the title only.
 *
 * Post-commit and best effort: the action has already happened, so nothing
 * here throws back at it. A failure logs the track id only.
 */
@Injectable()
export class StudioSafetyNoticesService {
  private readonly logger = new Logger(StudioSafetyNoticesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  claimAccepted(claimId: string, trackId: string): Promise<void> {
    return this.notifyOwners(
      trackId,
      NotificationType.StudioCopyrightClaimAccepted,
      { claimId },
    );
  }

  claimDeclined(
    claimId: string,
    claimantId: string,
    trackId: string,
  ): Promise<void> {
    return this.notifyClaimant(
      claimantId,
      trackId,
      NotificationType.StudioCopyrightClaimDeclined,
      { claimId },
    );
  }

  claimCountered(
    claimId: string,
    claimantId: string,
    trackId: string,
  ): Promise<void> {
    return this.notifyClaimant(
      claimantId,
      trackId,
      NotificationType.StudioCopyrightClaimCountered,
      { claimId },
    );
  }

  /** Two writes under one type: the claimant's row first, then the owners'. */
  async claimDecided(
    claimId: string,
    claimantId: string,
    trackId: string,
    outcome: StudioClaimOutcome,
  ): Promise<void> {
    await this.notifyClaimant(
      claimantId,
      trackId,
      NotificationType.StudioCopyrightClaimDecided,
      { claimId, outcome, recipientRole: 'claimant' },
    );
    await this.notifyOwners(
      trackId,
      NotificationType.StudioCopyrightClaimDecided,
      { claimId, outcome, recipientRole: 'owner' },
    );
  }

  claimWithdrawn(claimId: string, trackId: string): Promise<void> {
    return this.notifyOwners(
      trackId,
      NotificationType.StudioCopyrightClaimWithdrawn,
      { claimId },
    );
  }

  trackMarked(trackId: string, change: StudioTrackMarkChange): Promise<void> {
    return this.notifyOwners(trackId, NotificationType.StudioTrackMarked, {
      change,
    });
  }

  private async notifyOwners(
    trackId: string,
    type: NotificationType,
    extraPayload: Record<string, string>,
  ): Promise<void> {
    try {
      const rows: TrackNoticeRow[] = await this.dataSource.query(
        TRACK_NOTICE_SQL,
        [trackId],
      );
      const firstRow = rows[0];
      if (!firstRow) {
        return;
      }
      const recipientIds = [...new Set(rows.map((row) => row.user_id))];
      await this.notifications.createForRecipients(recipientIds, type, {
        ...extraPayload,
        trackId,
        releaseId: firstRow.release_id,
        trackTitle: firstRow.track_title,
      });
    } catch (error) {
      this.logger.warn(
        `Studio safety notice failed for track ${trackId}: ${String(error)}`,
      );
    }
  }

  // The claimant's rows carry no track or release id: their page is the
  // claims list, and the ids would add nothing they need.
  private async notifyClaimant(
    claimantId: string,
    trackId: string,
    type: NotificationType,
    extraPayload: Record<string, string>,
  ): Promise<void> {
    try {
      const rows: TrackNoticeRow[] = await this.dataSource.query(
        TRACK_NOTICE_SQL,
        [trackId],
      );
      const firstRow = rows[0];
      if (!firstRow) {
        return;
      }
      await this.notifications.create(claimantId, type, {
        ...extraPayload,
        trackTitle: firstRow.track_title,
      });
    } catch (error) {
      this.logger.warn(
        `Studio safety notice failed for track ${trackId}: ${String(error)}`,
      );
    }
  }
}
