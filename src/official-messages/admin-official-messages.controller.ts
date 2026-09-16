import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import {
  CreateOfficialBroadcastDto,
  SendOfficialMessageDto,
} from './dto/official-message.dto';
import { SearchOfficialRecipientsQuery } from './dto/search-official-recipients.query';
import { OfficialBroadcastsService } from './official-broadcasts.service';
import { OfficialConversationsService } from './official-conversations.service';
import { OfficialRecipientsService } from './official-recipients.service';
import {
  OfficialBroadcastResponse,
  OfficialMessageSentResponse,
  OfficialRecipientResponse,
} from './official-messages-response';

/**
 * PRD-372: speaking as QueerPulse itself, through each member's official
 * thread. Admin only, by product decision: a Moderator can never post here,
 * so `@Roles(UserRole.Admin)` stands alone with no `@StaffRoles` union.
 * Under the global Throttler, CSRF and JWT chain, plus RolesGuard here.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin: Official messages')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/official-messages')
export class AdminOfficialMessagesController {
  constructor(
    private readonly officialConversations: OfficialConversationsService,
    private readonly officialBroadcasts: OfficialBroadcastsService,
    private readonly officialRecipients: OfficialRecipientsService,
  ) {}

  @ApiOperation({ summary: 'Find a member to message officially.' })
  @ApiOkResponse({ description: 'Up to 20 matching members.' })
  @Get('recipients')
  searchRecipients(
    @Query() query: SearchOfficialRecipientsQuery,
  ): Promise<OfficialRecipientResponse[]> {
    return this.officialRecipients.search(query.q);
  }

  @ApiOperation({ summary: "Post to one member's official thread." })
  @ApiCreatedResponse({ description: 'The message was posted.' })
  @ApiBadRequestResponse({ description: 'Body missing or too long.' })
  @ApiNotFoundResponse({
    description: 'No such member (code OFFICIAL_RECIPIENT_NOT_FOUND).',
  })
  @Post('members/:memberId')
  sendToMember(
    @CurrentUser() actingAdmin: CurrentUserData,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: SendOfficialMessageDto,
  ): Promise<OfficialMessageSentResponse> {
    return this.officialConversations.postOfficialMessage(
      memberId,
      dto.body,
      actingAdmin.userId,
    );
  }

  @ApiOperation({
    summary: 'Broadcast to every active member; delivery runs in background.',
  })
  @ApiAcceptedResponse({ description: 'The broadcast row, status pending.' })
  @ApiBadRequestResponse({ description: 'Body or idempotency key invalid.' })
  @ApiConflictResponse({
    description:
      'The key belongs to a different broadcast (code OFFICIAL_BROADCAST_IDEMPOTENCY_CONFLICT).',
  })
  @Post('broadcast')
  @HttpCode(202)
  broadcast(
    @CurrentUser() actingAdmin: CurrentUserData,
    @Body() dto: CreateOfficialBroadcastDto,
  ): Promise<OfficialBroadcastResponse> {
    return this.officialBroadcasts.createBroadcast(
      dto.body,
      dto.idempotencyKey,
      actingAdmin.userId,
    );
  }

  @ApiOperation({ summary: 'The newest 50 broadcasts with their progress.' })
  @ApiOkResponse({ description: 'Broadcast history, newest first.' })
  @Get('broadcasts')
  listBroadcasts(): Promise<OfficialBroadcastResponse[]> {
    return this.officialBroadcasts.listBroadcasts();
  }
}
