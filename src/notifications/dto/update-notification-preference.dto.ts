import { IsBoolean, IsIn } from 'class-validator';
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NotificationPreferenceCategory,
} from '../notification-preferences';

/**
 * Body for `PUT /me/notification-preferences` — flips one category's channels.
 * A single-category PUT mirrors the UI (one toggle → one request) and keeps the
 * write path trivially idempotent.
 */
export class UpdateNotificationPreferenceDto {
  // Whitelisted to the known categories — an unknown category must 400 rather
  // than silently write a dead row the write path never reads.
  @IsIn(NOTIFICATION_PREFERENCE_CATEGORIES)
  category!: NotificationPreferenceCategory;

  @IsBoolean()
  inApp!: boolean;

  @IsBoolean()
  push!: boolean;
}
