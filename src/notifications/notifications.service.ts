import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';

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
  ) {}

  create(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
  ): Promise<Notification> {
    return this.notifications.save(
      this.notifications.create({ userId, type, payload }),
    );
  }

  async createForRecipients(
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    if (!userIds.length) {
      return;
    }
    await this.notifications.save(
      userIds.map((userId) =>
        this.notifications.create({ userId, type, payload }),
      ),
    );
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
}
