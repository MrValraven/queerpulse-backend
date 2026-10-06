import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { Feature } from '../common/feature.decorator';
import { BlockOptionsDto } from '../social/dto/block-options.dto';
import { MatchedChatMemberReportDto } from './dto/matched-chat-member-report.dto';
import {
  MatchedChatMemberBlockResponse,
  MatchedChatMemberReportResponse,
  MatchedChatMembersService,
} from './matched-chat-members.service';
import { MatchedChatMemberKeyPipe } from './matched-chat-member-key.pipe';

/**
 * PRD-423 (opaque member keys): member actions inside a matched Go together
 * chat, addressed by the per-chat member key the chat hands out. Shares the
 * `conversations` prefix with `ConversationsController`; its own class so
 * that controller's constructor stays as it is.
 */
@Feature('messaging')
@ApiTags('Messaging')
@ApiCookieAuth()
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('conversations')
@UseGuards(ActiveMemberGuard)
export class MatchedChatMembersController {
  constructor(private readonly matchedChatMembers: MatchedChatMembersService) {}

  /** Block the member behind a per-chat key, see
   *  `MatchedChatMembersService.blockMember`. Same throttle as a group
   *  member action. */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post(':id/members/:memberKey/block')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Block a member of a matched Go together chat by member key',
  })
  @ApiOkResponse({ description: '`{ blocking: true }`.' })
  @ApiBadRequestResponse({ description: 'The caller targeted themselves.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'Not a matched chat, or no member with that key in it.',
  })
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberKey', MatchedChatMemberKeyPipe) memberKey: string,
    @CurrentUser() user: CurrentUserData,
    @Body() options?: BlockOptionsDto,
  ): Promise<MatchedChatMemberBlockResponse> {
    return this.matchedChatMembers.blockMember(
      id,
      user.userId,
      memberKey,
      options,
    );
  }

  /** Report the member behind a per-chat key, see
   *  `MatchedChatMembersService.reportMember`. The same 10-a-minute burst
   *  throttle as Go together's member report. */
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':id/members/:memberKey/report')
  @ApiOperation({
    summary: 'Report a member of a matched Go together chat by member key',
  })
  @ApiCreatedResponse({
    description:
      "The filed report (or the caller's open report on that member), without its subject.",
  })
  @ApiBadRequestResponse({ description: 'The caller targeted themselves.' })
  @ApiForbiddenResponse({ description: 'The caller is not a participant.' })
  @ApiNotFoundResponse({
    description: 'Not a matched chat, or no member with that key in it.',
  })
  report(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberKey', MatchedChatMemberKeyPipe) memberKey: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: MatchedChatMemberReportDto,
  ): Promise<MatchedChatMemberReportResponse> {
    return this.matchedChatMembers.reportMember(
      id,
      user.userId,
      memberKey,
      dto,
    );
  }
}
