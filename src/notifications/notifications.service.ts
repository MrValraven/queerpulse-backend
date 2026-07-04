import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';

const LIST_LIMIT = 100;

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

  list(userId: string, unread?: boolean): Promise<Notification[]> {
    return this.notifications.find({
      where: { userId, ...(unread ? { read: false } : {}) },
      order: { createdAt: 'DESC' },
      take: LIST_LIMIT,
    });
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
