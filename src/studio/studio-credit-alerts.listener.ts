import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { CREDIT_PERSONAS_RELEASE_FROM_SQL } from './studio-credits-inbox.service';
import {
  STUDIO_CREDIT_ACCEPTED,
  STUDIO_CREDIT_REQUESTED,
  StudioCreditAcceptedEvent,
  StudioCreditRequestedEvent,
} from './studio-persona-credit.events';
import { listenablePersonaSql } from './studio-visibility';

/** The persona names fall back to the handle when the display name is
 *  blank, so the payload always carries a name the push can print. */
function personaNameSql(personaAlias: string): string {
  return `COALESCE(NULLIF(btrim("${personaAlias}"."display_name"), ''), "${personaAlias}"."handle")`;
}

/**
 * `$1` the credit, `$2` the status it must still hold. Everything both
 * payloads need, read only while both personas are public and the release
 * stands: a credit answered, removed or put out of reach in the meantime
 * sends nothing. No member column is read.
 */
export const CREDIT_ALERT_SQL = `SELECT "credit"."id" AS "credit_id",
       "credit"."role" AS "role",
       "credited"."id" AS "credited_subprofile_id",
       ${personaNameSql('credited')} AS "credited_persona_name",
       "credited"."handle" AS "credited_persona_handle",
       "requesting"."id" AS "requesting_subprofile_id",
       ${personaNameSql('requesting')} AS "requesting_persona_name",
       "requesting"."handle" AS "requesting_persona_handle",
       "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title"
  ${CREDIT_PERSONAS_RELEASE_FROM_SQL}
 WHERE "credit"."id" = $1
   AND "credit"."status" = $2
   AND "release"."status" <> 'taken_down'
   AND ${listenablePersonaSql('requesting')}
   AND ${listenablePersonaSql('credited')}`;

/** `$1` a persona, `$2` the acting member. The persona's members who hold a
 *  Studio grant, the acting member left out. */
export const CREDIT_ALERT_RECIPIENTS_SQL = `SELECT "member"."user_id" AS "user_id"
  FROM "subprofile_members" "member"
 WHERE "member"."subprofile_id" = $1
   AND "member"."user_id" <> $2
   AND EXISTS (
     SELECT 1 FROM "studio_access_grants" "member_grant"
      WHERE "member_grant"."user_id" = "member"."user_id"
   )
 ORDER BY "member"."user_id" ASC`;

interface CreditAlertRow {
  credit_id: string;
  role: string;
  credited_subprofile_id: string;
  credited_persona_name: string;
  credited_persona_handle: string;
  requesting_subprofile_id: string;
  requesting_persona_name: string;
  requesting_persona_handle: string;
  track_id: string;
  track_title: string;
  release_id: string;
  release_title: string;
}

/**
 * Studio discovery: the two credit notifications. The acting member's id
 * reaches `createForRecipients` for the block and mute filter only, so a
 * request that a block silences is stored and reaches nobody the block
 * covers, while the payload names personas alone. Push rides the batch
 * event, behind the `Personas` category and quiet hours.
 *
 * Best effort and post-commit: the write has already happened, so nothing
 * here throws back at it.
 */
@Injectable()
export class StudioCreditAlertsListener {
  private readonly logger = new Logger(StudioCreditAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_CREDIT_REQUESTED)
  async handleCreditRequested(
    event: StudioCreditRequestedEvent,
  ): Promise<void> {
    try {
      const credit = await this.readCredit(event.creditId, 'pending');
      if (!credit) {
        return;
      }
      const recipientIds = await this.recipientsOf(
        credit.credited_subprofile_id,
        event.requestingUserId,
      );
      if (!recipientIds.length) {
        return;
      }
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.StudioCreditRequested,
        {
          creditId: credit.credit_id,
          creditedSubprofileId: credit.credited_subprofile_id,
          creditedPersonaName: credit.credited_persona_name,
          creditedPersonaHandle: credit.credited_persona_handle,
          requestingPersonaName: credit.requesting_persona_name,
          requestingPersonaHandle: credit.requesting_persona_handle,
          trackId: credit.track_id,
          trackTitle: credit.track_title,
          releaseId: credit.release_id,
          releaseTitle: credit.release_title,
          role: credit.role,
        },
        event.requestingUserId,
      );
    } catch (error) {
      this.logger.warn(
        `Credit request alert failed for ${event.creditId}: ${String(error)}`,
      );
    }
  }

  @OnEvent(STUDIO_CREDIT_ACCEPTED)
  async handleCreditAccepted(event: StudioCreditAcceptedEvent): Promise<void> {
    try {
      const credit = await this.readCredit(event.creditId, 'accepted');
      if (!credit) {
        return;
      }
      const recipientIds = await this.recipientsOf(
        credit.requesting_subprofile_id,
        event.acceptingUserId,
      );
      if (!recipientIds.length) {
        return;
      }
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.StudioCreditAccepted,
        {
          creditId: credit.credit_id,
          requestingSubprofileId: credit.requesting_subprofile_id,
          requestingPersonaName: credit.requesting_persona_name,
          creditedPersonaName: credit.credited_persona_name,
          creditedPersonaHandle: credit.credited_persona_handle,
          trackId: credit.track_id,
          trackTitle: credit.track_title,
          releaseId: credit.release_id,
          releaseTitle: credit.release_title,
          role: credit.role,
        },
        event.acceptingUserId,
      );
    } catch (error) {
      this.logger.warn(
        `Credit accepted alert failed for ${event.creditId}: ${String(error)}`,
      );
    }
  }

  private async readCredit(
    creditId: string,
    status: 'pending' | 'accepted',
  ): Promise<CreditAlertRow | null> {
    const rows: CreditAlertRow[] = await this.dataSource.query(
      CREDIT_ALERT_SQL,
      [creditId, status],
    );
    return rows[0] ?? null;
  }

  private async recipientsOf(
    subprofileId: string,
    actingUserId: string,
  ): Promise<string[]> {
    const rows: { user_id: string }[] = await this.dataSource.query(
      CREDIT_ALERT_RECIPIENTS_SQL,
      [subprofileId, actingUserId],
    );
    return rows.map((row) => row.user_id);
  }
}
