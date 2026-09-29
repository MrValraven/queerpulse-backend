import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
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
import { CheckInDto } from './dto/check-in.dto';
import { FeedbackDto } from './dto/feedback.dto';
import { GoTogetherFeedbackService } from './go-together-feedback.service';
import { GoTogetherGroupService } from './go-together-group.service';

@Feature('events')
@ApiTags('Go together')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('go-together/groups')
@UseGuards(ActiveMemberGuard)
export class GoTogetherGroupsController {
  constructor(
    private readonly groups: GoTogetherGroupService,
    private readonly feedback: GoTogetherFeedbackService,
  ) {}

  @Get(':groupId')
  @ApiOperation({
    summary: "The caller's Go together group card. Grouped members only.",
  })
  @ApiOkResponse({ description: 'The group card.' })
  getGroup(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
  ) {
    return this.groups.getGroup(groupId, user.userId);
  }

  @Post(':groupId/checkin')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Say "I\'m here" or "I\'ve left" around the gathering.',
  })
  @ApiOkResponse({ description: 'The updated group card.' })
  checkIn(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: CheckInDto,
  ) {
    return this.groups.checkIn(groupId, user.userId, dto.status);
  }

  @Post(':groupId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave the group and its chat for this gathering.',
  })
  @ApiNoContentResponse({ description: 'The caller left the group.' })
  leave(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
  ) {
    return this.groups.leave(groupId, user.userId);
  }

  @Post(':groupId/merge/accept')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Move into the group the caller was offered after theirs got small.',
  })
  @ApiOkResponse({ description: 'The new group card.' })
  acceptMerge(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
  ) {
    return this.groups.acceptMerge(groupId, user.userId);
  }

  @Get(':groupId/feedback')
  @ApiOperation({
    summary: "The caller's private meet-again answers for this group.",
  })
  @ApiOkResponse({ description: 'The other members and the saved answers.' })
  getFeedback(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
  ) {
    return this.feedback.get(groupId, user.userId);
  }

  @Put(':groupId/feedback')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Save the private meet-again answers and the questions about the group.',
  })
  @ApiOkResponse({ description: 'The saved answers.' })
  putFeedback(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: FeedbackDto,
  ) {
    return this.feedback.put(groupId, user.userId, dto);
  }
}
