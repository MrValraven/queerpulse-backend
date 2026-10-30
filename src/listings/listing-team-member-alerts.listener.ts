import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { LISTING_TEAM_LISTING_RECIPIENTS_SQL } from './listing-team-alerts.listener';
import { ownerNameOf } from './listing-team-response';
import {
  LISTING_TEAM_MEMBER_ACCEPTED,
  LISTING_TEAM_MEMBER_INVITED,
  ListingTeamMemberAcceptedPayload,
  ListingTeamMemberAlertEvent,
  ListingTeamMemberInvitePayload,
} from './listing-team.events';

/** `$1` the team row, `$2` the status it must still hold. Member rows only
 *  (`user_id` set). A link answered or removed in the meantime returns no row
 *  and sends nothing. */
export const LISTING_TEAM_MEMBER_ALERT_SQL = `SELECT "member"."id", "member"."user_id" AS "member_user_id", "member"."role_label",
       "listing"."id" AS "listing_id", "listing"."ref" AS "listing_ref",
       "listing"."slug" AS "listing_slug", "listing"."name" AS "listing_name",
       "member_profile"."slug" AS "member_slug",
       "member_profile"."first_name" AS "member_first_name",
       "member_profile"."last_name" AS "member_last_name"
  FROM "listing_team_members" "member"
  INNER JOIN "listings" "listing" ON "listing"."id" = "member"."listing_id"
  LEFT JOIN "profiles" "member_profile" ON "member_profile"."user_id" = "member"."user_id"
 WHERE "member"."id" = $1 AND "member"."status" = $2 AND "member"."user_id" IS NOT NULL`;

/** `$1` the accepting member, `$2` the candidate recipient user ids. The
 *  recipients the member hid their profile from, who must not learn the
 *  member's name or slug from the acceptance. */
export const LISTING_TEAM_MEMBER_HIDDEN_FROM_SQL = `SELECT "hidden"."hidden_from_user_id"
  FROM "hidden_from_members" "hidden"
 WHERE "hidden"."owner_id" = $1 AND "hidden"."hidden_from_user_id" = ANY($2::uuid[])`;

interface TeamMemberAlertRow {
  id: string;
  member_user_id: string;
  role_label: string | null;
  listing_id: string;
  listing_ref: string;
  listing_slug: string;
  listing_name: string;
  member_slug: string | null;
  member_first_name: string | null;
  member_last_name: string | null;
}

/**
 * Meet the team, members: the two member link notifications. The invite goes
 * to the invited member alone; the acceptance goes to the listing owner and
 * active co-managers, never the accepting member and never a manager the
 * member hid their profile from. Neither names an actor: the
 * acting user's id reaches `createForRecipients` for the block and mute filter
 * only. Best effort and post-commit: nothing here throws back at the write.
 */
@Injectable()
export class ListingTeamMemberAlertsListener {
  private readonly logger = new Logger(ListingTeamMemberAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(LISTING_TEAM_MEMBER_INVITED)
  async handleInvited(event: ListingTeamMemberAlertEvent): Promise<void> {
    try {
      const row = await this.loadRow(event.memberId, 'pending');
      if (!row || row.member_user_id === event.actingUserId) {
        return;
      }
      const payload: ListingTeamMemberInvitePayload = {
        listingName: row.listing_name,
        listingSlug: row.listing_slug,
        roleLabel: row.role_label ?? null,
      };
      await this.notifications.createForRecipients(
        [row.member_user_id],
        NotificationType.ListingTeamMemberInvite,
        { ...payload },
        event.actingUserId,
      );
    } catch (error) {
      this.logWarning(event, error);
    }
  }

  @OnEvent(LISTING_TEAM_MEMBER_ACCEPTED)
  async handleAccepted(event: ListingTeamMemberAlertEvent): Promise<void> {
    try {
      const row = await this.loadRow(event.memberId, 'accepted');
      const memberName = row
        ? ownerNameOf(row.member_first_name, row.member_last_name)
        : null;
      if (!row || !row.member_slug || !memberName) {
        return;
      }
      const recipientRows: { user_id: string }[] = await this.dataSource.query(
        LISTING_TEAM_LISTING_RECIPIENTS_SQL,
        [row.listing_id, event.actingUserId],
      );
      const candidateIds = recipientRows
        .map((recipient) => recipient.user_id)
        .filter((userId) => userId !== row.member_user_id);
      if (!candidateIds.length) {
        return;
      }
      const hiddenRows: { hidden_from_user_id: string }[] =
        await this.dataSource.query(LISTING_TEAM_MEMBER_HIDDEN_FROM_SQL, [
          row.member_user_id,
          candidateIds,
        ]);
      const hiddenFromIds = new Set(
        hiddenRows.map((hidden) => hidden.hidden_from_user_id),
      );
      const recipientIds = candidateIds.filter(
        (userId) => !hiddenFromIds.has(userId),
      );
      if (!recipientIds.length) {
        return;
      }
      const payload: ListingTeamMemberAcceptedPayload = {
        listingRef: row.listing_ref,
        listingName: row.listing_name,
        listingSlug: row.listing_slug,
        memberName,
        memberSlug: row.member_slug,
      };
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.ListingTeamMemberAccepted,
        { ...payload },
        event.actingUserId,
      );
    } catch (error) {
      this.logWarning(event, error);
    }
  }

  private async loadRow(
    memberId: string,
    requiredStatus: 'pending' | 'accepted',
  ): Promise<TeamMemberAlertRow | undefined> {
    const rows: TeamMemberAlertRow[] = await this.dataSource.query(
      LISTING_TEAM_MEMBER_ALERT_SQL,
      [memberId, requiredStatus],
    );
    return rows[0];
  }

  private logWarning(event: ListingTeamMemberAlertEvent, error: unknown): void {
    this.logger.warn(
      `Team member alert failed for ${event.memberId}: ${String(error)}`,
    );
  }
}
