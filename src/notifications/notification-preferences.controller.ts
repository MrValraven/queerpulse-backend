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
import { NotificationPreferencesService } from './notification-preferences.service';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';

/**
 * Per-member, per-category notification preferences.
 *
 * Mounted under `/me/*` alongside the event-reminder-preferences controller
 * (same shape): a feature preference, so `ActiveMemberGuard` is the right gate
 * — an active member is the only actor who can meaningfully receive and mute
 * these notifications. Distinct from `NotificationsController`, which is
 * intentionally guard-light so a pending member can still READ vouch/promotion
 * notifications; a pending member has no preferences to set.
 */
@ApiTags('Preferences')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('me')
@UseGuards(ActiveMemberGuard)
export class NotificationPreferencesController {
  constructor(
    private readonly notificationPreferences: NotificationPreferencesService,
  ) {}

  // Returns every category's effective state (defaults ON) — never 404s and
  // never inserts a row.
  @Get('notification-preferences')
  @ApiOperation({ summary: 'Get your per-category notification preferences.' })
  @ApiOkResponse({
    description: 'Every category with its effective in-app/push state.',
  })
  get(@CurrentUser() user: CurrentUserData) {
    return this.notificationPreferences.get(user.userId);
  }

  @Put('notification-preferences')
  @ApiOperation({ summary: 'Set one category of notification preferences.' })
  @ApiOkResponse({ description: 'The full updated preference map.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateNotificationPreferenceDto,
  ) {
    return this.notificationPreferences.update(user.userId, body);
  }
}
