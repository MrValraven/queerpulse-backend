import { IsBoolean, IsIn } from 'class-validator';
import {
  EVENT_VISIBILITY_OPTIONS,
  EventVisibility,
} from '../entities/member-event-reminder-preferences.entity';

/**
 * Body for `PUT /me/event-settings`. Full replace of the two member event
 * settings the settings modal owns: the default visibility new events inherit
 * and whether event email notifications are on.
 */
export class UpdateEventSettingsDto {
  // Whitelisted to the three UI options — anything else 400s.
  @IsIn(EVENT_VISIBILITY_OPTIONS)
  defaultEventVisibility!: EventVisibility;

  @IsBoolean()
  eventEmailsEnabled!: boolean;
}
