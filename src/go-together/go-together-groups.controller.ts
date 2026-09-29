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
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { BlockOptionsDto } from '../social/dto/block-options.dto';
import { CheckInDto } from './dto/check-in.dto';
import { FeedbackDto } from './dto/feedback.dto';
import { GroupMemberReportDto } from './dto/group-member-report.dto';
import { GoTogetherFeedbackService } from './go-together-feedback.service';
import { GoTogetherGroupService } from './go-together-group.service';
import { GoTogetherLaunchGuard } from './go-together-launch.guard';

@Feature('goTogether')
@ApiTags('Go together')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('go-together/groups')
@UseGuards(ActiveMemberGuard, GoTogetherLaunchGuard)
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
    summary:
      'Leave the group and its chat for this gathering. From the start onward, leave the chat only.',
    description:
      'Before the gathering starts, the caller leaves Go together for it. From the start onward (the card reports `isLeaveChatOnly: true`) only their chat seat ends: they stay in the group, on the meet-again page, with their own reveal and feedback.',
  })
  @ApiNoContentResponse({
    description: 'The caller left the group, or its chat after the start.',
  })
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

  /**
   * PRD-421: Block one member from the group sheet, addressed by the opaque
   * `memberRef` the card hands out. Same service, body, event and side
   * effects as `POST /blocks/:slug`; the throttle is the global default,
   * like that route's. Answers 204, so nothing about the member leaves,
   * once the blocker's move out of the group has been attempted.
   */
  @Post(':groupId/members/:memberRef/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Block one member of the caller's group, from the group sheet.",
  })
  @ApiNoContentResponse({
    description:
      'The member is blocked (idempotent), and the move of the blocker out of the group (up to 12 hours after the start) has been attempted. A failed move is logged, and the block stands either way.',
  })
  @ApiBadRequestResponse({ description: 'The caller targeted themselves.' })
  @ApiNotFoundResponse({
    description:
      'The caller is not grouped in that group, or no member with that ref is seated there.',
  })
  blockMember(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Param('memberRef', new ParseUUIDPipe()) memberRef: string,
    @Body() dto?: BlockOptionsDto,
  ): Promise<void> {
    return this.groups.blockMember(groupId, user.userId, memberRef, dto);
  }

  /**
   * PRD-421: Report one member from the group sheet. Files through the same
   * pipeline as `POST /reports` (flood caps and severity included) with the
   * same 10-a-minute burst throttle, as a `member` subject resolved server
   * side from `memberRef`.
   */
  @Post(':groupId/members/:memberRef/report')
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: "Report one member of the caller's group, from the group sheet.",
  })
  @ApiCreatedResponse({
    description:
      "The filed report (or the caller's open report on that member), without its subject.",
  })
  @ApiBadRequestResponse({ description: 'The caller targeted themselves.' })
  @ApiNotFoundResponse({
    description:
      'The caller is not grouped in that group, or no member with that ref is seated there.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Too many reports, as on `POST /reports`. A rolling flood cap answers with ' +
      '`{ statusCode: 429, error: "Too Many Requests", code: "REPORT_FLOOD_CAP", cap: "daily" | "subject", message: string }`, ' +
      'whose `message` is member-facing copy. The burst throttle answers with no `code` and a framework message that is never shown to a member. ' +
      'Branch on `code === "REPORT_FLOOD_CAP"`.',
  })
  reportMember(
    @CurrentUser() user: CurrentUserData,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Param('memberRef', new ParseUUIDPipe()) memberRef: string,
    @Body() dto: GroupMemberReportDto,
  ) {
    return this.groups.reportMember(groupId, user.userId, memberRef, dto);
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
