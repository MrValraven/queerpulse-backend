import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import { BanEvasionEscalationsService } from './ban-evasion-escalations.service';
import { BanEvasionAssessmentDTO } from './ban-evasion-response';
import { BanEvasionService } from './ban-evasion.service';
import { BanEvasionEscalationDTO } from './community-ban-evasion-response';
import { AssessJoinRequestsQuery } from './dto/assess-join-requests.query';
import { ListBanEvasionEscalationsQuery } from './dto/list-ban-evasion-escalations.query';
import { ResolveBanEvasionEscalationDto } from './dto/resolve-ban-evasion-escalation.dto';
import { BanEvasionEscalationStatus } from './entities/ban-evasion-escalation.entity';

/**
 * Staff-only read surface for ban-evasion signals.
 *
 * READ ONLY, on purpose. There is no endpoint here that bans, blocks, declines
 * or holds anybody: the whole module produces a tier and a list of reasons for a
 * human reviewer, and every decision stays with that reviewer on the surface
 * they already use.
 *
 * Guarded exactly like `AdminJoinRequestsController`, the console that consumes
 * it: `ActiveMemberGuard` + `RolesGuard` with `@Roles(Moderator, Admin)`, at
 * class level so anything added here is staff-only by default.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Ban evasion')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/ban-evasion')
export class BanEvasionController {
  constructor(
    private readonly banEvasion: BanEvasionService,
    private readonly escalations: BanEvasionEscalationsService,
  ) {}

  /**
   * Assess a page of the invite review queue in one call. Returns one
   * assessment per id that resolved, `tier: 'none'` included, so the console can
   * tell "checked, clear" from "not checked yet".
   */
  @ApiOperation({
    summary: 'Ban-evasion signals for a batch of join requests (advisory).',
  })
  @ApiOkResponse({ description: 'One assessment per resolved join request.' })
  @ApiBadRequestResponse({ description: 'Malformed or oversized id list.' })
  @Get('join-requests')
  assessJoinRequests(
    @Query() query: AssessJoinRequestsQuery,
  ): Promise<BanEvasionAssessmentDTO[]> {
    return this.banEvasion.assessJoinRequests(query.ids);
  }

  /**
   * Assess one account that is already on the platform, for the case where
   * someone got in and staff are now asking whether this is a return.
   */
  @ApiOperation({
    summary: 'Ban-evasion signals for one existing account (advisory).',
  })
  @ApiOkResponse({ description: 'The assessment for that account.' })
  @Get('users/:userId')
  assessUser(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<BanEvasionAssessmentDTO> {
    return this.banEvasion.assessUser(userId);
  }

  /**
   * The escalation queue: community moderators asking staff to look at an
   * applicant they can only see one bit about.
   *
   * A community's own owner, co-owners and moderators are told whether an
   * applicant matches somebody THEIR community banned, and nothing more (see
   * `CommunityBanEvasionFlagDTO`). This is where the rest of the picture is,
   * and it is why the escalation exists: each row carries the FULL
   * cross-community assessment of the applicant inline, so a staff member reads
   * the case without a second call per row.
   */
  @ApiOperation({
    summary:
      'Ban-evasion escalations raised by community moderators, with the full ' +
      'cross-community assessment of each applicant attached.',
  })
  @ApiOkResponse({
    description: 'The escalations at that status, newest first.',
  })
  @ApiBadRequestResponse({ description: 'Unknown status.' })
  @Get('escalations')
  listEscalations(
    @Query() query: ListBanEvasionEscalationsQuery,
  ): Promise<BanEvasionEscalationDTO[]> {
    return this.escalations.list(
      query.status ?? BanEvasionEscalationStatus.Open,
    );
  }

  /**
   * Close one escalation. This is the only WRITE on this controller, and it
   * still bans nobody: it records that a staff member looked, and it releases
   * the "one open escalation per (community, join request)" lock so the
   * community can ask again later.
   *
   * `resolutionNote` stays here. It is never returned on any community-scoped
   * surface, which keeps the one-bit boundary the whole feature rests on
   * intact.
   */
  @ApiOperation({
    summary: 'Resolve a ban-evasion escalation, with an optional note.',
  })
  @ApiOkResponse({ description: 'The resolved escalation.' })
  @ApiBadRequestResponse({ description: 'Malformed id or note.' })
  @ApiNotFoundResponse({ description: 'No such escalation.' })
  @ApiConflictResponse({ description: 'The escalation is already resolved.' })
  @Patch('escalations/:id')
  resolveEscalation(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveBanEvasionEscalationDto,
  ): Promise<BanEvasionEscalationDTO> {
    return this.escalations.resolve(id, user.userId, dto.resolutionNote);
  }
}
