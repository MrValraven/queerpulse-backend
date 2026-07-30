import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
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
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('me')
@UseGuards(ActiveMemberGuard)
export class EventReminderPreferencesController {
  constructor(
    private readonly reminderPreferences: EventReminderPreferencesService,
  ) {}

  // Returns the default lead (1 day) when no row exists yet rather than 404.
  @Get('event-reminder-preferences')
  @ApiOperation({ summary: 'Get your event reminder lead time.' })
  @ApiOkResponse({
    description: 'The reminder lead time (default when unset).',
  })
  get(@CurrentUser() user: CurrentUserData) {
    return this.reminderPreferences.get(user.userId);
  }

  @Put('event-reminder-preferences')
  @ApiOperation({ summary: 'Update your event reminder lead time.' })
  @ApiOkResponse({ description: 'The updated reminder lead time.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateReminderPreferencesDto,
  ) {
    return this.reminderPreferences.update(user.userId, body);
  }
}
