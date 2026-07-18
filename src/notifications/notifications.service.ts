import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  ) {}

  async create(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
  ): Promise<Notification> {
    const saved = await this.notifications.save(
      this.notifications.create({ userId, type, payload }),
    );
    this.announce(saved);
    return saved;
  }

  async createForRecipients(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    if (!userIds.length) {
      return;
    }
    const saved = await this.notifications.save(
      userIds.map((userId) =>
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
