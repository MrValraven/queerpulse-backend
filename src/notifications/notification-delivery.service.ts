import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationDeliveryPreference } from './entities/notification-delivery-preference.entity';
import { UpdateNotificationDeliveryDto } from './dto/update-notification-delivery.dto';
import { isWithinQuietHours } from './notification-quiet-hours';

/** The defaults a member with no stored row is served and measured against. */
export const DEFAULT_QUIET_HOURS = {
  isQuietHoursEnabled: false,
  quietHoursStartMinute: 22 * 60,
  quietHoursEndMinute: 8 * 60,
  timeZone: 'UTC',
} as const;

/**
 * One member's delivery window as served to and accepted from the client.
 * Hand-mapped from the entity: there is no global serializer, and the raw row's
 * `userId` and timestamps are never leaked.
 */
export interface NotificationDeliveryResponse {
  isQuietHoursEnabled: boolean;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  timeZone: string;
}

/**
 * The quiet-hours store, and the gate the PUSH path consults.
 *
 * Rows are sparse overrides: no row means the defaults above, which have quiet
 * hours OFF, so a member who never opens settings is unaffected. The service
 * deletes the row again when a member returns to the exact default, keeping the
 * table sparse the way `NotificationPreferencesService` keeps its own.
 */
@Injectable()
export class NotificationDeliveryService {
  constructor(
    @InjectRepository(NotificationDeliveryPreference)
    private readonly deliveryPreferences: Repository<NotificationDeliveryPreference>,
  ) {}

  /** A member's window, defaults synthesised when they have no row. Never 404s. */
  async get(userId: string): Promise<NotificationDeliveryResponse> {
    const row = await this.deliveryPreferences.findOne({ where: { userId } });
    return {
      isQuietHoursEnabled:
        row?.isQuietHoursEnabled ?? DEFAULT_QUIET_HOURS.isQuietHoursEnabled,
      quietHoursStartMinute:
        row?.quietHoursStartMinute ?? DEFAULT_QUIET_HOURS.quietHoursStartMinute,
      quietHoursEndMinute:
        row?.quietHoursEndMinute ?? DEFAULT_QUIET_HOURS.quietHoursEndMinute,
      timeZone: row?.timeZone ?? DEFAULT_QUIET_HOURS.timeZone,
    };
  }

  /** Replace a member's window, then echo it back so the client can cache it. */
  async update(
    userId: string,
    dto: UpdateNotificationDeliveryDto,
  ): Promise<NotificationDeliveryResponse> {
    const isDefault =
      dto.isQuietHoursEnabled === DEFAULT_QUIET_HOURS.isQuietHoursEnabled &&
      dto.quietHoursStartMinute === DEFAULT_QUIET_HOURS.quietHoursStartMinute &&
      dto.quietHoursEndMinute === DEFAULT_QUIET_HOURS.quietHoursEndMinute &&
      dto.timeZone === DEFAULT_QUIET_HOURS.timeZone;
    if (isDefault) {
      await this.deliveryPreferences.delete({ userId });
      return this.get(userId);
    }
    const row =
      (await this.deliveryPreferences.findOne({ where: { userId } })) ??
      this.deliveryPreferences.create({ userId });
    row.isQuietHoursEnabled = dto.isQuietHoursEnabled;
    row.quietHoursStartMinute = dto.quietHoursStartMinute;
    row.quietHoursEndMinute = dto.quietHoursEndMinute;
    row.timeZone = dto.timeZone;
    await this.deliveryPreferences.save(row);
    return this.get(userId);
  }

  /**
   * The subset of `userIds` whose local clock is NOT inside their quiet-hours
   * window right now, preserving order and duplicates.
   *
   * One batched query for the whole send, in the shape of
   * `NotificationPreferencesService.disabledUserIds`: only members with a stored
   * row can be quiet, so a single `IN (...)` over the sparse table answers for
   * everyone. An empty table (the common case today) costs one indexed lookup
   * that returns nothing and lets the whole batch through.
   */
  async recipientsOutsideQuietHours(
    userIds: string[],
    instant: Date = new Date(),
  ): Promise<string[]> {
    if (userIds.length === 0) return userIds;
    const rows = await this.deliveryPreferences.find({
      where: { userId: In([...new Set(userIds)]), isQuietHoursEnabled: true },
    });
    if (rows.length === 0) return userIds;
    const quietUserIds = new Set(
      rows
        .filter((row) => isWithinQuietHours(row, instant))
        .map((row) => row.userId),
    );
    return userIds.filter((userId) => !quietUserIds.has(userId));
  }
}
