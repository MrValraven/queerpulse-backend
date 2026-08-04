import { IsIn, IsInt } from 'class-validator';
import { ALLOWED_REMINDER_LEAD_MINUTES } from '../entities/member-event-reminder-preferences.entity';

/** Body for `PUT /me/event-reminder-preferences`. */
export class UpdateReminderPreferencesDto {
  // Whitelisted to the three UI options — the cron trusts this value for
  // `startAt − leadMinutes` arithmetic, so an out-of-range integer must 400.
  @IsInt()
  @IsIn(ALLOWED_REMINDER_LEAD_MINUTES)
  leadMinutes!: number;
}
