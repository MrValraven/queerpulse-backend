import {
  IsBoolean,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { MINUTES_PER_DAY, isKnownTimeZone } from '../notification-quiet-hours';

/**
 * Rejects a time zone this runtime's zone database does not know. Written as a
 * constraint class rather than a regex because the only authority on what is a
 * real zone is the ICU data the send path will later read the clock through.
 */
@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isKnownTimeZone(value);
  }

  defaultMessage(): string {
    return 'timeZone must be an IANA time zone name, for example Europe/Lisbon';
  }
}

/**
 * Body for `PUT /me/notification-delivery`: the member's quiet-hours window.
 *
 * Every field is required, so the stored window is always a complete statement
 * and a partial write can never leave a half-set window enforcing something the
 * member did not choose. Turning quiet hours off keeps the start/end the member
 * picked, so switching them back on restores their window rather than the
 * default one.
 */
export class UpdateNotificationDeliveryDto {
  @IsBoolean()
  isQuietHoursEnabled!: boolean;

  @IsInt()
  @Min(0)
  @Max(MINUTES_PER_DAY - 1)
  quietHoursStartMinute!: number;

  @IsInt()
  @Min(0)
  @Max(MINUTES_PER_DAY - 1)
  quietHoursEndMinute!: number;

  @IsString()
  @MaxLength(64)
  @Validate(IsIanaTimeZoneConstraint)
  timeZone!: string;
}
