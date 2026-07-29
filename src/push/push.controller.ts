import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { PushSubscribeDto } from './dto/push-subscribe.dto';
import { PushUnsubscribeDto } from './dto/push-unsubscribe.dto';
import { PushService } from './push.service';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Push Notifications')
@ApiCookieAuth()
@Controller('push')
@UseGuards(ActiveMemberGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  // A device (re)subscribes rarely; a modest cap keeps the endpoint from being
  // used to churn subscription rows without disrupting legitimate use.
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

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('unsubscribe')
  async unsubscribe(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PushUnsubscribeDto,
  ): Promise<{ ok: true }> {
    await this.pushService.removeSubscription(user.userId, dto.endpoint);
    return { ok: true };
  }
}
