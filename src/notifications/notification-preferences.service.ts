import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationType } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import {
  DEFAULT_PREFERENCE_ENABLED,
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NotificationPreferenceCategory,
  NotificationPreferencesResponse,
  categoryForType,
} from './notification-preferences';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';

/**
 * The member-facing notification-preference store, and the gate the write path
 * consults. Rows are sparse overrides (see the entity): no row means the
 * all-ON default, so every lookup treats a missing row as "enabled".
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectRepository(NotificationPreference)
    private readonly preferences: Repository<NotificationPreference>,
  ) {}

  /**
   * The full preference map for the settings pane: every category with its
   * effective state, defaults synthesised for categories with no stored row.
   * A GET never inserts (a member merely opening settings must not acquire
   * rows), matching `EventReminderPreferencesService.get`.
   */
  async get(userId: string): Promise<NotificationPreferencesResponse> {
    const rows = await this.preferences.find({ where: { userId } });
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    const preferences: NotificationPreferencesResponse['preferences'] = {};
    for (const category of NOTIFICATION_PREFERENCE_CATEGORIES) {
      const stored = byCategory.get(category);
      preferences[category] = {
        inApp: stored?.inApp ?? DEFAULT_PREFERENCE_ENABLED,
        push: stored?.push ?? DEFAULT_PREFERENCE_ENABLED,
      };
    }
    return { preferences };
  }

  /**
   * Set one category's channels, then echo the full map back so the client can
   * replace its cache in one shot. Keeps the table sparse: a category returned
   * to the all-ON default drops its row rather than storing a redundant
   * "everything on" override.
   */
  async update(
    userId: string,
    dto: UpdateNotificationPreferenceDto,
  ): Promise<NotificationPreferencesResponse> {
    const isDefault =
      dto.inApp === DEFAULT_PREFERENCE_ENABLED &&
      dto.push === DEFAULT_PREFERENCE_ENABLED;
    if (isDefault) {
      await this.preferences.delete({ userId, category: dto.category });
    } else {
      const row =
        (await this.preferences.findOne({
          where: { userId, category: dto.category },
        })) ?? this.preferences.create({ userId, category: dto.category });
      row.inApp = dto.inApp;
      row.push = dto.push;
      await this.preferences.save(row);
    }
    return this.get(userId);
  }

  /**
   * Whether an in-app notification of `type` should be delivered to `userId`.
   * `true` for any type with no member switch (safety/system types), and `true`
   * by default for a switched type with no stored override.
   */
  async isInAppEnabled(
    userId: string,
    type: NotificationType,
  ): Promise<boolean> {
    const category = categoryForType(type);
    if (!category) return true;
    const row = await this.preferences.findOne({
      where: { userId, category },
    });
    return row?.inApp ?? DEFAULT_PREFERENCE_ENABLED;
  }

  /**
   * The subset of `userIds` that still want an in-app notification of `type`,
   * preserving order and duplicates — the fan-out sibling of `isInAppEnabled`,
   * one batched query total. A type with no member switch returns everyone.
   */
  async recipientsInAppEnabled(
    userIds: string[],
    type: NotificationType,
  ): Promise<string[]> {
    const category = categoryForType(type);
    if (!category || userIds.length === 0) return userIds;
    const disabled = await this.disabledUserIds(userIds, category, 'inApp');
    return userIds.filter((userId) => !disabled.has(userId));
  }

  /**
   * The subset of `userIds` that still want a phone push for `category`,
   * preserving order — used by the push listener. One batched query total.
   */
  async recipientsPushEnabled(
    userIds: string[],
    category: NotificationPreferenceCategory,
  ): Promise<string[]> {
    if (userIds.length === 0) return userIds;
    const disabled = await this.disabledUserIds(userIds, category, 'push');
    return userIds.filter((userId) => !disabled.has(userId));
  }

  /**
   * The subset of `userIds` with a stored row turning `channel` OFF for
   * `category`. Only rows that exist can disable — a missing row is the ON
   * default — so a single `IN (...)` query over the sparse table suffices.
   */
  private async disabledUserIds(
    userIds: string[],
    category: NotificationPreferenceCategory,
    channel: 'inApp' | 'push',
  ): Promise<Set<string>> {
    const uniqueUserIds = [...new Set(userIds)];
    const rows = await this.preferences.find({
      where: { userId: In(uniqueUserIds), category },
      select: { userId: true, inApp: true, push: true },
    });
    return new Set(
      rows.filter((row) => row[channel] === false).map((row) => row.userId),
    );
  }
}
