import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
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
import { ReportConversationContextDTO } from './report-conversation-context-response';
import { ReportConversationContextService } from './report-conversation-context.service';

/**
 * PRD-360: the staff conversation viewer for a message report. Same guards as
 * `ModerationController` (moderator or admin only, no community carve-out:
 * reading a private conversation is a platform staff act). A sibling
 * controller so the audited read sits apart from the queue and decision
 * routes. Frontend contract: `queerpulse/src/features/admin/api/moderation.api.ts`.
 */
@ApiTags('Admin — Moderation')
@ApiCookieAuth()
@Controller('mod')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class ReportConversationContextController {
  constructor(
    private readonly conversationContext: ReportConversationContextService,
  ) {}

  @Get('reports/:id/conversation-context')
  // A private conversation, specific to who is asking: never cached anywhere.
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Open up to 20 messages either side of a reported message (writes an audit row)',
  })
  @ApiOkResponse({ description: 'The ordered message window.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({
    description:
      'No such report, or it is not a message report whose message still exists (code CONVERSATION_CONTEXT_UNAVAILABLE).',
  })
  getConversationContext(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ReportConversationContextDTO> {
    return this.conversationContext.getContext(id, user.userId);
  }
}
