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
import { NotificationDeliveryService } from './notification-delivery.service';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';
import { UpdateNotificationDeliveryDto } from './dto/update-notification-delivery.dto';

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
    private readonly notificationDelivery: NotificationDeliveryService,
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

  // Quiet hours. A separate pair of routes from the category map above because
  // it answers a different question: the category map is WHICH notifications,
  // this is WHEN a phone may buzz for the ones that survived it.
  @Get('notification-delivery')
  @ApiOperation({ summary: 'Get your quiet-hours window.' })
  @ApiOkResponse({
    description:
      'The window and the time zone it is measured in. Never 404s: a member with no stored window gets the defaults, which have quiet hours off.',
  })
  getDelivery(@CurrentUser() user: CurrentUserData) {
    return this.notificationDelivery.get(user.userId);
  }

  @Put('notification-delivery')
  @ApiOperation({ summary: 'Set your quiet-hours window.' })
  @ApiOkResponse({ description: 'The updated window.' })
  updateDelivery(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateNotificationDeliveryDto,
  ) {
    return this.notificationDelivery.update(user.userId, body);
  }
}
