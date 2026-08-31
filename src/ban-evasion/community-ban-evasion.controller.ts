import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
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
import { CommunityBanEvasionService } from './community-ban-evasion.service';
import {
  CommunityBanEvasionEscalationDTO,
  CommunityBanEvasionFlagDTO,
} from './community-ban-evasion-response';
import { AssessJoinRequestsQuery } from './dto/assess-join-requests.query';
import { EscalateBanEvasionDto } from './dto/escalate-ban-evasion.dto';
import { ListCommunityEscalationsQuery } from './dto/list-community-escalations.query';

/**
 * `@Controller('communities/:slug/join-requests')`: a standalone controller on
 * a nested path, the convention this module follows for
 * `CommunityBansController` and `CommunityInvitesController`. It lives in
 * `src/ban-evasion` rather than in `src/communities` because everything it
 * decides is ban-evasion policy, and keeping it beside
 * `CommunityBanEvasionFlagDTO` puts the wire shape and the privacy argument
 * that constrains it in the same folder as the route that serves them.
 *
 * ALL THREE ROUTES are owner, co-owner or moderator OF THIS COMMUNITY
 * (`resolveStaffCommunity`), never platform staff by role: a platform moderator
 * with no roster row here reads the same case on `/admin/ban-evasion`, in full.
 *
 * There is no route here that declines, bars or holds anybody. The badge is one
 * bit for a human to weigh, and the escalation is a question.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/join-requests')
@UseGuards(ActiveMemberGuard)
export class CommunityBanEvasionController {
  constructor(
    private readonly communityBanEvasion: CommunityBanEvasionService,
  ) {}

  /**
   * The badge for a page of the queue, in one call. Batched deliberately: a
   * per-request lookup would put an N+1 on a triage screen.
   */
  @Get('ban-evasion')
  @ApiOperation({
    summary:
      'Does each of these applicants match somebody THIS community banned? ' +
      'One yes/no per join request, for the owner, a co-owner or a moderator.',
  })
  @ApiOkResponse({
    description:
      'One `{ joinRequestId, isMatchingBannedMember }` per id that resolved ' +
      "to one of this community's own join requests. Nothing else: no tier, " +
      'no score, no matched signal, no prior account, no date. A match ' +
      'against another community, or against a platform-level ban, answers ' +
      '`false` here and belongs to platform staff.',
  })
  @ApiBadRequestResponse({ description: 'Malformed or oversized id list.' })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  flags(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: AssessJoinRequestsQuery,
  ): Promise<CommunityBanEvasionFlagDTO[]> {
    return this.communityBanEvasion.flagJoinRequests(
      slug,
      user.userId,
      query.ids,
    );
  }

  /**
   * What this community has already escalated. The companion to the POST
   * below: escalating is idempotent, so the screen needs to know which
   * applicants are already in front of staff.
   */
  @Get('escalations')
  @ApiOperation({
    summary:
      'Ban-evasion escalations this community has raised (owner, co-owner or ' +
      'moderator). Both open and resolved unless `status` narrows it.',
  })
  @ApiOkResponse({
    description:
      "This community's own escalations, newest first. Each carries `id`, " +
      '`joinRequestId`, `status`, `createdAt` and `note`. It carries nothing ' +
      'staff added: no assessment, no resolution note, no resolver, no ' +
      'resolution date. A moderator learns that they asked and whether the ' +
      'question was closed, and nothing about what staff found.',
  })
  @ApiBadRequestResponse({ description: 'Unknown status.' })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  listEscalations(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListCommunityEscalationsQuery,
  ): Promise<CommunityBanEvasionEscalationDTO[]> {
    return this.communityBanEvasion.listEscalations(
      slug,
      user.userId,
      query.status,
    );
  }

  /**
   * Hand the case to platform staff, who can see the whole picture. Idempotent
   * while an escalation is open: pressing it twice returns the same row.
   */
  @Post(':id/escalate-ban-evasion')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Ask platform staff to look at this applicant, who can see every ' +
      'community and the platform ban list (owner, co-owner or moderator).',
  })
  @ApiCreatedResponse({
    description:
      'The open escalation. Pressing this again while it is open returns the ' +
      'same one. It carries no part of the assessment: the escalation is the ' +
      'question, and the answer lands with staff.',
  })
  @ApiBadRequestResponse({ description: 'Malformed id or note.' })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, an archived community, or no such join request here.',
  })
  escalate(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EscalateBanEvasionDto,
  ): Promise<CommunityBanEvasionEscalationDTO> {
    return this.communityBanEvasion.escalate(slug, user.userId, id, dto.note);
  }
}
