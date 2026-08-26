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
import {
  ApiBadRequestResponse,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminReadingGroupProposalsService } from './admin-reading-group-proposals.service';
import { DecideReadingGroupProposalDto } from './dto/decide-reading-group-proposal.dto';
import { DeclineReadingGroupProposalDto } from './dto/decline-reading-group-proposal.dto';
import { ListAdminReadingGroupProposalsQuery } from './dto/list-admin-reading-group-proposals.query';

/**
 * Admin oversight of reading-group proposals: every "Start your own group" a
 * member has submitted, paginated and optionally filtered by format. Guarded
 * with `ActiveMemberGuard` + `RolesGuard`.
 *
 * One class-level `@Roles(Moderator, Admin)` covers the whole surface. It
 * previously read `@Roles(Admin)` with a per-handler `@Roles(Moderator, Admin)`
 * on approve/decline/archive; because `RolesGuard` resolves roles with
 * `Reflector.getAllAndOverride`, the method decorator *replaced* the class one,
 * so moderators could decide a proposal but got 403 on the `GET` that lists the
 * queue they were deciding from (BE-COM-29). Deciding is the wider permission,
 * so the read is widened to match rather than the decisions narrowed.
 *
 * The member-facing write stays on `ReadingGroupProposalsController`.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('communities')
@ApiTags('Admin — Reading-group proposals')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the `communities` staff role.',
})
@Controller('admin/reading-group-proposals')
export class AdminReadingGroupProposalsController {
  constructor(
    private readonly adminReadingGroupProposals: AdminReadingGroupProposalsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List reading-group proposals (paginated).' })
  @ApiOkResponse({ description: 'One page of reading-group proposals.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminReadingGroupProposalsQuery) {
    return this.adminReadingGroupProposals.list(query);
  }

  // Approving CREATES the community the member proposed, owned by them, and
  // notifies them (LOC-19). Idempotent: a second approve on a proposal that
  // already built its community returns that proposal unchanged rather than
  // creating a second one, so this stays safe to retry.
  @Post(':id/approve')
  @ApiOperation({
    summary:
      "Approve a reading-group proposal — creates the proposer's community.",
  })
  @ApiOkResponse({
    description: 'The proposal, now approved, carrying its community slug.',
  })
  @ApiBadRequestResponse({ description: 'Malformed id or note.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideReadingGroupProposalDto,
  ) {
    return this.adminReadingGroupProposals.approve(id, user.userId, dto.note);
  }

  // A decline needs a reason, and the proposer is told it. `reason` is
  // required by `DeclineReadingGroupProposalDto`, which is why this handler
  // does not share the optional-note body the other two use.
  @Post(':id/decline')
  @ApiOperation({
    summary: 'Decline a reading-group proposal (reason required).',
  })
  @ApiOkResponse({ description: 'The proposal, now declined.' })
  @ApiBadRequestResponse({ description: 'Malformed id, or a missing reason.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DeclineReadingGroupProposalDto,
  ) {
    return this.adminReadingGroupProposals.decline(id, user.userId, dto.reason);
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a reading-group proposal.' })
  @ApiOkResponse({ description: 'The proposal, now archived.' })
  @ApiBadRequestResponse({ description: 'Malformed id or note.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideReadingGroupProposalDto,
  ) {
    return this.adminReadingGroupProposals.archive(id, user.userId, dto.note);
  }
}
