import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  LISTING_TEAM_ACCEPTED,
  LISTING_TEAM_INVITED,
  LISTING_TEAM_REQUESTED,
  ListingTeamAlertEvent,
} from './listing-team.events';

/** `$1` the team row, `$2` the status it must still hold. A link answered or
 *  removed in the meantime returns no row and sends nothing. */
export const LISTING_TEAM_ALERT_SQL = `SELECT "member"."id", "member"."initiated_by", "member"."role_label",
       "listing"."id" AS "listing_id", "listing"."ref" AS "listing_ref",
       "listing"."slug" AS "listing_slug", "listing"."name" AS "listing_name",
       "persona"."id" AS "subprofile_id", "persona"."handle" AS "persona_handle",
       COALESCE(NULLIF(btrim("persona"."display_name"), ''), "persona"."handle") AS "persona_name"
  FROM "listing_team_members" "member"
  INNER JOIN "listings" "listing" ON "listing"."id" = "member"."listing_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "member"."subprofile_id"
 WHERE "member"."id" = $1 AND "member"."status" = $2`;

/** `$1` a persona, `$2` the acting member. */
export const LISTING_TEAM_PERSONA_RECIPIENTS_SQL = `SELECT "user_id" FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" <> $2 ORDER BY "user_id"`;

/** `$1` a listing, `$2` the acting member. The owner when set, unioned with
 *  the active co-managers. */
export const LISTING_TEAM_LISTING_RECIPIENTS_SQL = `SELECT "recipient"."user_id" FROM (
  SELECT "listing"."owner_id" AS "user_id" FROM "listings" "listing"
   WHERE "listing"."id" = $1 AND "listing"."owner_id" IS NOT NULL
  UNION
  SELECT "co_manager"."user_id" AS "user_id" FROM "listing_co_managers" "co_manager"
   WHERE "co_manager"."listing_id" = $1 AND "co_manager"."status" = 'active'
) "recipient"
 WHERE "recipient"."user_id" <> $2
 ORDER BY "recipient"."user_id"`;

interface TeamAlertRow {
  id: string;
  initiated_by: 'listing' | 'persona';
  role_label: string | null;
  listing_id: string;
  listing_ref: string;
  listing_slug: string;
  listing_name: string;
  subprofile_id: string;
  persona_handle: string;
  persona_name: string;
}

type TeamSide = 'listing' | 'persona';

/**
 * Meet the team: the three link notifications. The acting member's id
 * reaches `createForRecipients` for the block and mute filter only and is
 * left out of the recipients; payloads carry listing and persona fields
 * alone. Best effort and post-commit: nothing here throws back at the write.
 */
@Injectable()
export class ListingTeamAlertsListener {
  private readonly logger = new Logger(ListingTeamAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(LISTING_TEAM_INVITED)
  async handleInvited(event: ListingTeamAlertEvent): Promise<void> {
    await this.send(event, 'pending', 'persona', (row) => ({
      type: NotificationType.ListingTeamInvite,
      payload: {
        subprofileId: row.subprofile_id,
        personaName: row.persona_name,
        listingName: row.listing_name,
        listingSlug: row.listing_slug,
        roleLabel: row.role_label ?? null,
      },
    }));
  }

  @OnEvent(LISTING_TEAM_REQUESTED)
  async handleRequested(event: ListingTeamAlertEvent): Promise<void> {
    await this.send(event, 'pending', 'listing', (row) => ({
      type: NotificationType.ListingTeamRequest,
      payload: {
        listingRef: row.listing_ref,
        listingName: row.listing_name,
        personaName: row.persona_name,
        personaHandle: row.persona_handle,
      },
    }));
  }

  @OnEvent(LISTING_TEAM_ACCEPTED)
  async handleAccepted(event: ListingTeamAlertEvent): Promise<void> {
    await this.send(
      event,
      'accepted',
      (row) => row.initiated_by,
      (row) => ({
        type: NotificationType.ListingTeamAccepted,
        payload: {
          initiatedBy: row.initiated_by,
          listingName: row.listing_name,
          listingSlug: row.listing_slug,
          personaName: row.persona_name,
          personaHandle: row.persona_handle,
          ...(row.initiated_by === 'listing'
            ? { listingRef: row.listing_ref }
            : { subprofileId: row.subprofile_id }),
        },
      }),
    );
  }

  private async send(
    event: ListingTeamAlertEvent,
    requiredStatus: 'pending' | 'accepted',
    recipientSide: TeamSide | ((row: TeamAlertRow) => TeamSide),
    build: (row: TeamAlertRow) => {
      type: NotificationType;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      const rows: TeamAlertRow[] = await this.dataSource.query(
        LISTING_TEAM_ALERT_SQL,
        [event.memberId, requiredStatus],
      );
      const row = rows[0];
      if (!row) {
        return;
      }
      const side =
        typeof recipientSide === 'function'
          ? recipientSide(row)
          : recipientSide;
      const recipientRows: { user_id: string }[] = await this.dataSource.query(
        side === 'persona'
          ? LISTING_TEAM_PERSONA_RECIPIENTS_SQL
          : LISTING_TEAM_LISTING_RECIPIENTS_SQL,
        [
          side === 'persona' ? row.subprofile_id : row.listing_id,
          event.actingUserId,
        ],
      );
      const recipientIds = recipientRows.map((recipient) => recipient.user_id);
      if (!recipientIds.length) {
        return;
      }
      const { type, payload } = build(row);
      await this.notifications.createForRecipients(
        recipientIds,
        type,
        payload,
        event.actingUserId,
      );
    } catch (error) {
      this.logger.warn(
        `Team alert failed for ${event.memberId}: ${String(error)}`,
      );
    }
  }
}
