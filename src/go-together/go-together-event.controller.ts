import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
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
import { HostConfigDto } from './dto/host-config.dto';
import { OptInDto, PairAnswersDto } from './dto/opt-in.dto';
import { GoTogetherEntryService } from './go-together-entry.service';
import { GoTogetherHostService } from './go-together-host.service';

@Feature('events')
@ApiTags('Go together')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('events')
@UseGuards(ActiveMemberGuard)
export class GoTogetherEventController {
  constructor(
    private readonly entries: GoTogetherEntryService,
    private readonly host: GoTogetherHostService,
  ) {}

  @Get(':slug/go-together')
  @ApiOperation({
    summary: "The caller's Go together card for this gathering.",
  })
  @ApiOkResponse({ description: 'The card state and what it needs.' })
  card(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.entries.card(slug, user.userId);
  }

  @Post(':slug/go-together')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Opt in alone or with one friend, or update the opt-in answers.',
  })
  @ApiOkResponse({ description: 'The updated card.' })
  optIn(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: OptInDto,
  ) {
    return this.entries.optIn(slug, user.userId, dto);
  }

  @Delete(':slug/go-together')
  @ApiOperation({
    summary: 'Withdraw a waiting opt-in. Grouped members use Leave group.',
  })
  @ApiOkResponse({ description: 'The updated card.' })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.entries.withdraw(slug, user.userId);
  }

  @Post(':slug/go-together/pair/accept')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: "Accept a friend's invite to go together." })
  @ApiOkResponse({ description: 'The updated card.' })
  acceptPair(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: PairAnswersDto,
  ) {
    return this.entries.acceptPair(slug, user.userId, dto);
  }

  @Post(':slug/go-together/pair/decline')
  @ApiOperation({
    summary: "Decline a friend's invite; the friend stays in alone.",
  })
  @ApiOkResponse({ description: 'The updated card.' })
  declinePair(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.entries.declinePair(slug, user.userId);
  }

  @Get(':slug/go-together/config')
  @ApiOperation({
    summary: 'The Go together settings for this gathering. Hosts only.',
  })
  @ApiOkResponse({ description: 'The host settings.' })
  getConfig(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.host.getConfig(slug, user.userId);
  }

  @Put(':slug/go-together/config')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Turn Go together on or off and set the matching time, host questions and meeting point. Hosts only.',
  })
  @ApiOkResponse({ description: 'The saved host settings.' })
  putConfig(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: HostConfigDto,
  ) {
    return this.host.putConfig(slug, user.userId, dto);
  }

  @Get(':slug/go-together/summary')
  @ApiOperation({
    summary: 'How many members are waiting, grouped or unmatched. Hosts only.',
  })
  @ApiOkResponse({ description: 'Counts only, with no member ids.' })
  summary(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.host.summary(slug, user.userId);
  }
}
