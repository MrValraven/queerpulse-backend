import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { UpsertFriendMatchProfileDto } from './dto/upsert-friend-match-profile.dto';
import { GoTogetherProfileService } from './go-together-profile.service';

@Feature('events')
@ApiTags('Go together')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('go-together')
@UseGuards(ActiveMemberGuard)
export class GoTogetherProfileController {
  constructor(private readonly profiles: GoTogetherProfileService) {}

  @Get('profile')
  @ApiOperation({
    summary: "The caller's own Go together answers, or an empty profile.",
  })
  @ApiOkResponse({ description: 'The questionnaire state.' })
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.profiles.getMine(user.userId);
  }

  @Put('profile')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: "Create or replace the caller's answers. Requires consent: true.",
  })
  upsertMine(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpsertFriendMatchProfileDto,
  ) {
    return this.profiles.upsertMine(user.userId, dto);
  }

  @Delete('profile')
  @ApiOperation({
    summary:
      'Withdraw consent: delete the answers and leave every waiting match.',
  })
  deleteMine(@CurrentUser() user: CurrentUserData) {
    return this.profiles.deleteMine(user.userId);
  }
}
