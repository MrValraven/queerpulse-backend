import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { PushSubscribeDto } from './dto/push-subscribe.dto';
import { PushUnsubscribeDto } from './dto/push-unsubscribe.dto';
import { PushService } from './push.service';

@Controller('push')
@UseGuards(ActiveMemberGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Post('subscribe')
  async subscribe(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PushSubscribeDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<{ ok: true }> {
    await this.pushService.saveSubscription(user.userId, dto, userAgent);
    return { ok: true };
  }

  @Post('unsubscribe')
  async unsubscribe(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PushUnsubscribeDto,
  ): Promise<{ ok: true }> {
    await this.pushService.removeSubscription(user.userId, dto.endpoint);
    return { ok: true };
  }
}
