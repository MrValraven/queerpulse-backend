import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { EventReminderPreferencesService } from './event-reminder-preferences.service';
import { UpdateReminderPreferencesDto } from './dto/update-reminder-preferences.dto';

/**
 * Member event-reminder preference (currently just the lead time).
 *
 * Mounted under `/me/*` alongside `PreferencesController` rather than under
 * `/events/*`, because `EventsController` owns `GET /events/:slug` — a literal
 * `events/reminder-preferences` route would be shadowed by that param route.
 * `ActiveMemberGuard` is appropriate here (this is a feature preference, not a
 * safety control), matching the other `/me/*` feature routes.
 */
@ApiTags('Preferences')
@ApiCookieAuth()
@Controller('me')
@UseGuards(ActiveMemberGuard)
export class EventReminderPreferencesController {
  constructor(
    private readonly reminderPreferences: EventReminderPreferencesService,
  ) {}

  // Returns the default lead (1 day) when no row exists yet rather than 404.
  @Get('event-reminder-preferences')
  get(@CurrentUser() user: CurrentUserData) {
    return this.reminderPreferences.get(user.userId);
  }

  @Put('event-reminder-preferences')
  update(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateReminderPreferencesDto,
  ) {
    return this.reminderPreferences.update(user.userId, body);
  }
}
