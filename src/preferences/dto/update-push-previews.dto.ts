import { IsBoolean } from 'class-validator';

/**
 * `PUT /me/push-previews`: the single lock-screen-preview switch.
 *
 * The field is named for what it DOES rather than borrowing
 * `UpdateLoginAlertsDto`'s `enabled`: "enabled: true" reads as "previews on"
 * to half the people who see it and "hiding on" to the other half, and a
 * privacy control that can be wired backwards by a plausible misreading is a
 * control that will eventually be wired backwards.
 *
 * Turning it on never suppresses a notification. The bell row is written in
 * full, the push is still delivered, and the app shows everything once it is
 * open. What changes is only what reaches a lock screen: a generic title and
 * body, no actor avatar, no preview image.
 */
export class UpdatePushPreviewsDto {
  @IsBoolean()
  hidePreviews!: boolean;
}
