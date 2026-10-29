import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { UserStatus } from '../users/entities/user.entity';
import {
  STUDIO_ACCESS_GRANTED,
  StudioAccessGrantedEvent,
} from './studio.events';

/** `$1` the member. One row while the grant stands and the account is active. */
export const ACCESS_GRANTED_ALERT_SQL = `SELECT "member_account"."id" AS "user_id"
  FROM "studio_access_grants" "access_grant"
 INNER JOIN "users" "member_account" ON "member_account"."id" = "access_grant"."user_id"
 WHERE "access_grant"."user_id" = $1
   AND "member_account"."status" = '${UserStatus.Active}'`;

/**
 * Studio landing page: tells a member their Studio access was granted.
 * Best effort and post-commit. The staff member who granted it is never
 * read, and the payload is empty.
 */
@Injectable()
export class StudioAccessAlertsListener {
  private readonly logger = new Logger(StudioAccessAlertsListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(STUDIO_ACCESS_GRANTED)
  async onAccessGranted(event: StudioAccessGrantedEvent): Promise<void> {
    try {
      const rows: { user_id: string }[] = await this.dataSource.query(
        ACCESS_GRANTED_ALERT_SQL,
        [event.userId],
      );
      if (!rows.length) {
        return;
      }
      await this.notifications.createForRecipients(
        [event.userId],
        NotificationType.StudioAccessGranted,
        {},
      );
    } catch (error) {
      this.logger.warn(`Studio access alert failed: ${String(error)}`);
    }
  }
}
