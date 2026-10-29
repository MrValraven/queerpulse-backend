import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  STUDIO_PURCHASE_CLAIMED,
  STUDIO_PURCHASE_CONFIRMED,
  STUDIO_PURCHASE_DECLINED,
  STUDIO_PURCHASE_EXPIRED,
  StudioPurchaseEvent,
} from './studio-purchase.events';
import { describePlayErrorWithoutIds } from './studio-play-log';

type PurchaseAlertStatus = 'pending' | 'confirmed' | 'declined' | 'expired';

/**
 * `$1` the purchase, `$2` the status it must still hold. The artist name is
 * the live persona name (display name, else handle) while the persona
 * exists and the snapshot once it is gone; the item title follows the same
 * rule against the release or track. A purchase that left the status the
 * event names returns no row, so a claim that was confirmed or cancelled
 * in the meantime sends nothing.
 */
export const PURCHASE_ALERT_SQL = `SELECT "purchase"."id" AS "purchase_id",
       "purchase"."subprofile_id" AS "subprofile_id",
       "purchase"."buyer_user_id" AS "buyer_user_id",
       CASE
         WHEN "persona"."id" IS NOT NULL
           THEN COALESCE(NULLIF(btrim("persona"."display_name"), ''), "persona"."handle", "purchase"."artist_name")
         ELSE "purchase"."artist_name"
       END AS "artist_name",
       "purchase"."item_kind"::text AS "item_kind",
       COALESCE("release"."title", "track"."title", "purchase"."item_title") AS "item_title",
       "purchase"."amount_cents" AS "amount_cents",
       "purchase"."decline_reason"::text AS "decline_reason"
  FROM "studio_purchases" "purchase"
  LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "purchase"."subprofile_id"
  LEFT JOIN "studio_releases" "release" ON "release"."id" = "purchase"."release_id"
  LEFT JOIN "studio_tracks" "track" ON "track"."id" = "purchase"."track_id"
 WHERE "purchase"."id" = $1
   AND "purchase"."status"::text = $2`;

/** `$1` a persona. Every member who holds a Studio grant, no member left
 *  out, since the alert carries no actor. */
export const PURCHASE_ALERT_RECIPIENTS_SQL = `SELECT "member"."user_id" AS "user_id"
  FROM "subprofile_members" "member"
 WHERE "member"."subprofile_id" = $1
   AND EXISTS (
     SELECT 1 FROM "studio_access_grants" "member_grant"
      WHERE "member_grant"."user_id" = "member"."user_id"
   )
 ORDER BY "member"."user_id" ASC`;

interface PurchaseAlertRow {
  purchase_id: string;
  subprofile_id: string | null;
  buyer_user_id: string | null;
  artist_name: string;
  item_kind: string;
  item_title: string;
  amount_cents: number;
  decline_reason: string | null;
}

/**
 * Studio purchases: the four payment notifications (contract section 8).
 * The claim reaches the persona's members that hold a Studio grant; the
 * confirmation, the decline and the expiry reach the buyer. None of them
 * carries an `actorId`, so neither a mute nor a later block silences a
 * payment record. The buyer is never named in a payload and the decline
 * note stays out of it.
 *
 * Best effort and post-commit: the write has already happened, so nothing
 * here throws back at it. A failure logs the error class and the Postgres
 * code only.
 */
@Injectable()
export class StudioPurchaseAlertsListener {
  private readonly logger = new Logger(StudioPurchaseAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_PURCHASE_CLAIMED)
  async handleClaimed(event: StudioPurchaseEvent): Promise<void> {
    await this.sendAlert(event, 'pending', async (purchase) => {
      if (!purchase.subprofile_id) {
        return;
      }
      const recipientIds = await this.membersOf(purchase.subprofile_id);
      if (!recipientIds.length) {
        return;
      }
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.StudioPurchaseClaimed,
        {
          purchaseId: purchase.purchase_id,
          subprofileId: purchase.subprofile_id,
          artistName: purchase.artist_name,
          itemKind: purchase.item_kind,
          itemTitle: purchase.item_title,
          amountCents: purchase.amount_cents,
        },
      );
    });
  }

  @OnEvent(STUDIO_PURCHASE_CONFIRMED)
  async handleConfirmed(event: StudioPurchaseEvent): Promise<void> {
    await this.sendToBuyer(
      event,
      'confirmed',
      NotificationType.StudioPurchaseConfirmed,
    );
  }

  @OnEvent(STUDIO_PURCHASE_DECLINED)
  async handleDeclined(event: StudioPurchaseEvent): Promise<void> {
    await this.sendToBuyer(
      event,
      'declined',
      NotificationType.StudioPurchaseDeclined,
    );
  }

  @OnEvent(STUDIO_PURCHASE_EXPIRED)
  async handleExpired(event: StudioPurchaseEvent): Promise<void> {
    await this.sendToBuyer(
      event,
      'expired',
      NotificationType.StudioPurchaseExpired,
    );
  }

  private async sendToBuyer(
    event: StudioPurchaseEvent,
    status: PurchaseAlertStatus,
    type: NotificationType,
  ): Promise<void> {
    await this.sendAlert(event, status, async (purchase) => {
      if (!purchase.buyer_user_id) {
        return;
      }
      const payload: Record<string, unknown> = {
        purchaseId: purchase.purchase_id,
        artistName: purchase.artist_name,
        itemKind: purchase.item_kind,
        itemTitle: purchase.item_title,
      };
      if (status === 'declined') {
        payload.declineReason = purchase.decline_reason;
      }
      await this.notifications.createForRecipients(
        [purchase.buyer_user_id],
        type,
        payload,
      );
    });
  }

  private async sendAlert(
    event: StudioPurchaseEvent,
    status: PurchaseAlertStatus,
    send: (purchase: PurchaseAlertRow) => Promise<void>,
  ): Promise<void> {
    try {
      const rows: PurchaseAlertRow[] = await this.dataSource.query(
        PURCHASE_ALERT_SQL,
        [event.purchaseId, status],
      );
      const purchase = rows[0];
      if (!purchase) {
        return;
      }
      await send(purchase);
    } catch (error) {
      this.logger.warn(
        `Studio purchase alert failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }

  private async membersOf(subprofileId: string): Promise<string[]> {
    const rows: { user_id: string }[] = await this.dataSource.query(
      PURCHASE_ALERT_RECIPIENTS_SQL,
      [subprofileId],
    );
    return rows.map((row) => row.user_id);
  }
}
