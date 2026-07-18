import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Notification, NotificationType } from './entities/notification.entity';
import {
  NOTIFICATION_CREATED,
  NotificationCreatedEvent,
} from './notification.events';

const PAGE_SIZE = 20;

export interface NotificationsPage {
  items: Notification[];
  page: number;
  hasMore: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly eventEmitter: EventEmitter2,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /**
   * Creates a notification for `userId`, unless `actorId` (the member whose
   * action triggered it) is hidden from the recipient — blocked in either
   * direction, or muted by the recipient. Returns `null` when suppressed.
   *
   * ENFORCEMENT POINT — write time, not read time. Three reasons this is the
   * right side of the line:
   *  1. `announce()` pushes every persisted notification straight to the
   *     recipient's live sockets (`notification:new`, via the chat gateway).
   *     A read-time filter in `list()` could never unring that bell — the
   *     blocked member's name would still pop up in real time. Suppressing the
   *     write suppresses the push too, because the push hangs off the write.
   *  2. The actor is buried in `payload` under a per-type key
   *     (`fromUserId` / `byUserId` / `voucherId` / `senderId` / `inviterId`),
   *     so a read-time filter would have to reverse-engineer JSON by
   *     `NotificationType` and silently miss any type added later. At write
   *     time each caller already holds the actor id as a typed value.
   *  3. `unreadCount()` is a separate query from `list()`; filtering at read
   *     time means keeping two independent filters in sync or shipping a badge
   *     count that never matches the list below it.
   * The trade-off — notifications created *before* a block are not
   * retroactively hidden — is consistent with how blocks behave elsewhere and
   * is why this is enforcement, not history rewriting.
   */
  async create(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
    actorId?: string,
  ): Promise<Notification | null> {
    if (actorId && (await this.isHiddenFrom(userId, actorId))) {
      return null;
    }
    const saved = await this.notifications.save(
      this.notifications.create({ userId, type, payload }),
    );
    this.announce(saved);
    return saved;
  }

  /** Fan-out sibling of `create`, with the same write-time actor filter
   *  applied per recipient (a block/mute is one recipient's relationship, so
   *  it must never suppress the notification for everybody else). */
  async createForRecipients(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown> = {},
    actorId?: string,
  ): Promise<void> {
    const recipients = actorId
      ? await this.visibleRecipients(userIds, actorId)
      : userIds;
    if (!recipients.length) {
      return;
    }
    const saved = await this.notifications.save(
      recipients.map((userId) =>
        this.notifications.create({ userId, type, payload }),
      ),
    );
    for (const notification of saved) {
      this.announce(notification);
    }
  }

  async list(
    userId: string,
    opts: { unread?: boolean; page?: number } = {},
  ): Promise<NotificationsPage> {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    // Fetch one extra row to detect a following page without a second count.
    const rows = await this.notifications.find({
      where: { userId, ...(opts.unread ? { read: false } : {}) },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    });
    const hasMore = rows.length > PAGE_SIZE;
    return { items: hasMore ? rows.slice(0, PAGE_SIZE) : rows, page, hasMore };
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.count({ where: { userId, read: false } });
  }

  async markRead(id: string, userId: string): Promise<{ ok: true }> {
    const result = await this.notifications.update(
      { id, userId },
      { read: true },
    );
    if (!result.affected) {
      throw new NotFoundException('Notification not found');
    }
    return { ok: true };
  }

  async markAllRead(userId: string): Promise<{ ok: true }> {
    await this.notifications.update({ userId, read: false }, { read: true });
    return { ok: true };
  }

  /**
   * `true` when `actorId`'s actions must not reach `recipientId`: blocked in
   * either direction (hard severance), or muted by the recipient — mutes are
   * one-way and `BlockFilterService.isMutedBy`'s docstring names "notifications
   * skipped" as exactly what a mute does. A member is never hidden from
   * themself (both helpers short-circuit on equal ids), so self-notifications
   * still go through.
   */
  private async isHiddenFrom(
    recipientId: string,
    actorId: string,
  ): Promise<boolean> {
    const [blocked, muted] = await Promise.all([
      this.blockFilter.isBlockedEitherWay(recipientId, actorId),
      this.blockFilter.isMutedBy(recipientId, actorId),
    ]);
    return blocked || muted;
  }

  /** Per-recipient application of `isHiddenFrom` for the fan-out path. */
  private async visibleRecipients(
    userIds: string[],
    actorId: string,
  ): Promise<string[]> {
    const flags = await Promise.all(
      userIds.map((userId) => this.isHiddenFrom(userId, actorId)),
    );
    return userIds.filter((_, i) => !flags[i]);
  }

  /**
   * Announce a persisted notification on the internal event bus. The chat
   * gateway listens and pushes it to the recipient's live sockets as
   * `notification:new`; emitting only after the write means a pushed
   * notification always has a row behind it.
   *
   * `emit` is synchronous and fire-and-forget — a listener that throws must
   * never fail the write that produced the notification.
   */
  private announce(notification: Notification): void {
    const event: NotificationCreatedEvent = {
      userId: notification.userId,
      notification,
    };
    this.eventEmitter.emit(NOTIFICATION_CREATED, event);
  }
}
