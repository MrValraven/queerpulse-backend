import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  STUDIO_RELEASE_DISPUTE_DECIDED,
  STUDIO_RELEASE_TAKEN_DOWN,
  StudioReleaseDisputeDecidedEvent,
  StudioReleaseTakenDownEvent,
} from './studio.events';

/** One owner of the release's persona, with the release title. */
export interface ReleaseNoticeRecipientRow {
  release_title: string;
  user_id: string;
}

/**
 * The release's owners: the persona's creator (`subprofiles.user_id`) and
 * every member of its roster, each once (`UNION` drops the creator's own
 * roster row), in user id order. A release that is gone returns no row.
 */
export const RELEASE_NOTICE_RECIPIENTS_SQL = `SELECT "release"."title" AS "release_title",
       "owner"."user_id" AS "user_id"
  FROM "studio_releases" "release"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 INNER JOIN LATERAL (
   SELECT "persona"."user_id" AS "user_id"
    UNION
   SELECT "persona_member"."user_id" AS "user_id"
     FROM "subprofile_members" "persona_member"
    WHERE "persona_member"."subprofile_id" = "persona"."id"
 ) "owner" ON true
 WHERE "release"."id" = $1
 ORDER BY "owner"."user_id"`;

/**
 * Studio open demo pages (section 5.3): tells a release's owners that staff
 * took it down, or decided their dispute about it. Both notices are
 * always delivered and name no actor: `createForRecipients` gets no actor
 * id, so no block or mute between an owner and a staff member can swallow
 * one. The payload carries the release id and title (and the outcome for a
 * decision); the reason and the staff reply stay on the release page.
 *
 * Post-commit and best effort: the takedown or the decision has already
 * happened, so nothing here throws back at it.
 */
@Injectable()
export class StudioReleaseNoticesListener {
  private readonly logger = new Logger(StudioReleaseNoticesListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_RELEASE_TAKEN_DOWN)
  async handleReleaseTakenDown(
    event: StudioReleaseTakenDownEvent,
  ): Promise<void> {
    await this.notifyOwners(
      event.releaseId,
      NotificationType.StudioReleaseTakenDown,
      {},
    );
  }

  @OnEvent(STUDIO_RELEASE_DISPUTE_DECIDED)
  async handleDisputeDecided(
    event: StudioReleaseDisputeDecidedEvent,
  ): Promise<void> {
    await this.notifyOwners(
      event.releaseId,
      NotificationType.StudioReleaseDisputeDecided,
      { outcome: event.outcome },
    );
  }

  private async notifyOwners(
    releaseId: string,
    type: NotificationType,
    extraPayload: Record<string, string>,
  ): Promise<void> {
    try {
      const rows: ReleaseNoticeRecipientRow[] = await this.dataSource.query(
        RELEASE_NOTICE_RECIPIENTS_SQL,
        [releaseId],
      );
      const firstRow = rows[0];
      if (!firstRow) {
        return;
      }
      const recipientIds = [...new Set(rows.map((row) => row.user_id))];
      await this.notifications.createForRecipients(recipientIds, type, {
        releaseId,
        releaseTitle: firstRow.release_title,
        ...extraPayload,
      });
    } catch (error) {
      this.logger.warn(
        `Studio release notice failed for ${releaseId}: ${String(error)}`,
      );
    }
  }
}
