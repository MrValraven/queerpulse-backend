import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { PushSubscribeDto } from './dto/push-subscribe.dto';
import { PushUnsubscribeDto } from './dto/push-unsubscribe.dto';
import {
  PushSubscriptionResponse,
  toPushSubscriptionResponse,
} from './push-response';
import { PushService } from './push.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@ApiTags('Push Notifications')
@ApiCookieAuth('access_token')
@Controller('push')
@UseGuards(ActiveMemberGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  // A device (re)subscribes rarely; a modest cap keeps the endpoint from being
  // used to churn subscription rows without disrupting legitimate use.
  @ApiOperation({ summary: 'Register a Web Push subscription for the caller' })
  @ApiCreatedResponse({
    description: 'The subscription was saved (`{ ok: true }`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('subscribe')
  async subscribe(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PushSubscribeDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<{ ok: true }> {
    await this.pushService.saveSubscription(user.userId, dto, userAgent);
    return { ok: true };
  }

  @ApiOperation({ summary: 'Remove a Web Push subscription for the caller' })
  @ApiCreatedResponse({
    description: 'The subscription was removed (`{ ok: true }`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('unsubscribe')
  async unsubscribe(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PushUnsubscribeDto,
  ): Promise<{ ok: true }> {
    await this.pushService.removeSubscription(user.userId, dto.endpoint);
    return { ok: true };
  }

  // Lets a member see every device currently registered to receive their
  // pushes — the "Devices" list in Settings. Newest-first, unpaginated (a
  // member has, at most, a handful of devices).
  @ApiOperation({
    summary: "List the caller's registered push subscriptions (devices)",
  })
  @ApiOkResponse({ description: 'The subscriptions, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get('subscriptions')
  async listSubscriptions(
    @CurrentUser() user: CurrentUserData,
  ): Promise<PushSubscriptionResponse[]> {
    const rows = await this.pushService.listSubscriptions(user.userId);
    return rows.map(toPushSubscriptionResponse);
  }

  // Remote-revoke one device's push subscription — the answer to "my phone
  // was stolen, stop sending it my notifications" when the member no longer
  // has that device to unsubscribe from itself. Ownership is enforced by
  // userId in the service, not just the row id, so a caller can never revoke
  // another member's subscription by guessing an id.
  @ApiOperation({
    summary: "Remove one of the caller's push subscriptions (devices)",
  })
  @ApiNoContentResponse({ description: 'The subscription was removed.' })
  @ApiBadRequestResponse({ description: 'Malformed subscription id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'Subscription not found.' })
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Delete('subscriptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSubscriptionById(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.pushService.removeSubscriptionById(user.userId, id);
  }

  // Lets a member fire a single push to their own devices to confirm the whole
  // chain works (permission + subscription + delivery). Throttled like the
  // other push routes so it can't be used to spam a device.
  @ApiOperation({ summary: 'Send the caller a test push notification' })
  @ApiCreatedResponse({
    description: 'The test push was sent (`{ ok: true }`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('test')
  async test(@CurrentUser() user: CurrentUserData): Promise<{ ok: true }> {
    await this.pushService.sendToUser(user.userId, {
      title: 'Test notification',
      body: 'This is a test — your notifications are working.',
      tag: 'push-test',
      data: { url: '/account/settings' },
      // English strings above are the fallback (iOS, and when the SW lacks the
      // key); the service worker localizes from these keys when it can.
      l10n: { titleKey: 'push:test.title', bodyKey: 'push:test.body' },
    });
    return { ok: true };
  }
}
