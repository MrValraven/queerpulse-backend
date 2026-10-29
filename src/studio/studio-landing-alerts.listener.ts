import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { grantHoldingPersonaMembersSql } from './studio-landing-sql';
import {
  STUDIO_LANDING_PREVIEW_APPROVED,
  STUDIO_LANDING_PREVIEW_REQUESTED,
  StudioLandingPreviewApprovedEvent,
  StudioLandingPreviewRequestedEvent,
} from './studio.events';

/**
 * `$1` the preview, `$2` the status it must still hold. The release persona
 * and the track title both payloads need. No member column is read.
 */
export const PREVIEW_ALERT_SQL = `SELECT "preview"."id" AS "preview_id",
       "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "persona"."id" AS "persona_id",
       COALESCE(NULLIF(btrim("persona"."display_name"), ''), "persona"."handle") AS "persona_name"
  FROM "studio_landing_previews" "preview"
 INNER JOIN "studio_tracks" "track" ON "track"."id" = "preview"."track_id"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "preview"."id" = $1
   AND "preview"."status"::text = $2`;

/**
 * `$1` the track. The release persona first (rank 0), then every persona with
 * an accepted credit on the track (rank 1), each persona once.
 */
export const PREVIEW_LIVE_PERSONAS_SQL = `SELECT "release"."subprofile_id" AS "persona_id", 0 AS "rank"
  FROM "studio_tracks" "track"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 WHERE "track"."id" = $1
 UNION
SELECT "credit"."subprofile_id" AS "persona_id", 1 AS "rank"
  FROM "studio_persona_credits" "credit"
 INNER JOIN "studio_tracks" "credited_track" ON "credited_track"."id" = "credit"."track_id"
 INNER JOIN "studio_releases" "credited_release" ON "credited_release"."id" = "credited_track"."release_id"
 WHERE "credit"."track_id" = $1
   AND "credit"."status"::text = 'accepted'
   AND "credit"."subprofile_id" <> "credited_release"."subprofile_id"
 ORDER BY "rank" ASC, "persona_id" ASC`;

/** `$1` a persona. Its members who hold a Studio grant and an active account. */
export const PREVIEW_RECIPIENTS_SQL = `SELECT "user_id" FROM ${grantHoldingPersonaMembersSql('$1', 'alert')} "recipient" ORDER BY "user_id" ASC`;

interface PreviewAlertRow {
  preview_id: string;
  track_id: string;
  track_title: string;
  persona_id: string;
  persona_name: string;
}

interface PersonaRow {
  persona_id: string;
}

interface RecipientRow {
  user_id: string;
}

/**
 * Studio landing page: the two preview notifications. Best effort and
 * post-commit: the write has already happened, so nothing here throws back at
 * it. Every send leaves the actor out, so no member id reaches the fan-out.
 */
@Injectable()
export class StudioLandingAlertsListener {
  private readonly logger = new Logger(StudioLandingAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_LANDING_PREVIEW_REQUESTED)
  async onPreviewRequested(
    event: StudioLandingPreviewRequestedEvent,
  ): Promise<void> {
    try {
      const preview = await this.readPreview(event.previewId, 'pending');
      if (!preview) {
        return;
      }
      const recipientIds = await this.recipientsOf(preview.persona_id);
      if (!recipientIds.length) {
        return;
      }
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.StudioLandingPreviewRequested,
        {
          previewId: preview.preview_id,
          subprofileId: preview.persona_id,
          personaName: preview.persona_name,
          trackTitle: preview.track_title,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Landing preview request alert failed: ${String(error)}`,
      );
    }
  }

  @OnEvent(STUDIO_LANDING_PREVIEW_APPROVED)
  async onPreviewApproved(
    event: StudioLandingPreviewApprovedEvent,
  ): Promise<void> {
    try {
      const preview = await this.readPreview(event.previewId, 'approved');
      if (!preview) {
        return;
      }
      const personaRows: PersonaRow[] = await this.dataSource.query(
        PREVIEW_LIVE_PERSONAS_SQL,
        [preview.track_id],
      );
      const alreadySentUserIds = new Set<string>([event.approverUserId]);
      // Each persona sends on its own: a failed send logs and the fan-out
      // moves on to the next persona. A member of a failed persona stays
      // unsent, so a later persona they also run can still reach them.
      for (const personaRow of personaRows) {
        try {
          const recipientIds = (
            await this.recipientsOf(personaRow.persona_id)
          ).filter((userId) => !alreadySentUserIds.has(userId));
          if (!recipientIds.length) {
            continue;
          }
          await this.notifications.createForRecipients(
            recipientIds,
            NotificationType.StudioLandingPreviewLive,
            {
              previewId: preview.preview_id,
              subprofileId: personaRow.persona_id,
              mainPersonaName: preview.persona_name,
              trackTitle: preview.track_title,
            },
          );
          recipientIds.forEach((userId) => alreadySentUserIds.add(userId));
        } catch (error) {
          this.logger.warn(
            `Landing preview live alert for one artist failed: ${String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`Landing preview live alert failed: ${String(error)}`);
    }
  }

  private async readPreview(
    previewId: string,
    status: 'pending' | 'approved',
  ): Promise<PreviewAlertRow | null> {
    const rows: PreviewAlertRow[] = await this.dataSource.query(
      PREVIEW_ALERT_SQL,
      [previewId, status],
    );
    return rows[0] ?? null;
  }

  private async recipientsOf(personaId: string): Promise<string[]> {
    const rows: RecipientRow[] = await this.dataSource.query(
      PREVIEW_RECIPIENTS_SQL,
      [personaId],
    );
    return rows.map((row) => row.user_id);
  }
}
