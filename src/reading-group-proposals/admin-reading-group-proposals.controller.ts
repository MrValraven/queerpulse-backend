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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminReadingGroupProposalsService } from './admin-reading-group-proposals.service';
import { DecideReadingGroupProposalDto } from './dto/decide-reading-group-proposal.dto';
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
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Reading-group proposals')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the moderator or admin role.',
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

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a reading-group proposal.' })
  @ApiOkResponse({ description: 'The proposal, now approved.' })
  @ApiBadRequestResponse({ description: 'Malformed id or note.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideReadingGroupProposalDto,
  ) {
    return this.adminReadingGroupProposals.approve(id, user.userId, dto.note);
  }

  @Post(':id/decline')
  @ApiOperation({ summary: 'Decline a reading-group proposal.' })
  @ApiOkResponse({ description: 'The proposal, now declined.' })
  @ApiBadRequestResponse({ description: 'Malformed id or note.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideReadingGroupProposalDto,
  ) {
    return this.adminReadingGroupProposals.decline(id, user.userId, dto.note);
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
