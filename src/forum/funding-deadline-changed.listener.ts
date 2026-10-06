import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SavedItem } from '../saved/entities/saved-item.entity';
import {
  FORUM_FUNDING_DEADLINE_CHANGED,
  ForumFundingDeadlineChangedEvent,
} from './forum.events';
import { fundingSaverVisibleSql } from './funding-saver-visibility';

// Savers of this thread who can still read it: the same gates the reminder
// sweeper applies, so no saver hears the title or new date of a removed or
// hidden call, of a call behind a block, or of a call in a gated community or
// space they cannot read.
const SAVER_SQL = `
  SELECT DISTINCT "saved"."user_id" AS "user_id"
    FROM "saved_item" "saved"
    JOIN "forum_thread" "thread"
      ON "thread"."slug" = "saved"."subject_id"
   WHERE "saved"."subject_type" = 'post'
     AND "thread"."id" = $1
     AND ${fundingSaverVisibleSql('"thread"', '"saved"')}`;

/**
 * Funding & Grants (P3): tells the members who saved an open call that its
 * deadline moved, with the new date (`funding_deadline_changed`).
 *
 * A saved forum post stores the thread SLUG as `saved_item.subject_id`
 * (`subject_type = 'post'`), the same key `SavedAvailabilityService` reads.
 * The author and whoever made the edit are left out: they already know.
 *
 * A call that became rolling (`deadline` null) sends nothing, because the copy
 * names a date. The reminder ledger needs no clean-up here: its key includes
 * the deadline, so the new date earns fresh reminders on its own.
 *
 * Best-effort, like `TopicFollowNotificationsListener`: the edit has already
 * committed, and a failure here is logged and dropped.
 */
@Injectable()
export class FundingDeadlineChangedListener {
  private readonly logger = new Logger(FundingDeadlineChangedListener.name);

  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(FORUM_FUNDING_DEADLINE_CHANGED)
  async onDeadlineChanged(
    event: ForumFundingDeadlineChangedEvent,
  ): Promise<void> {
    if (event.deadline === null) return;
    try {
      const saverRows = await this.savedItems.query<{ user_id: string }[]>(
        SAVER_SQL,
        [event.threadId],
      );
      const recipientIds = [
        ...new Set(saverRows.map((row) => row.user_id)),
      ].filter(
        (userId) => userId !== event.editorId && userId !== event.authorId,
      );
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.FundingDeadlineChanged,
        {
          source: 'forum',
          threadSlug: event.threadSlug,
          threadTitle: event.threadTitle,
          deadline: event.deadline,
        },
        // Block and mute filtering against the author only; the payload
        // carries no `actorId`, so the bell names nobody.
        event.authorId ?? undefined,
      );
    } catch (error) {
      this.logger.warn(
        `Funding deadline-changed notification failed for thread ${event.threadId}: ${String(error)}`,
      );
    }
  }
}
