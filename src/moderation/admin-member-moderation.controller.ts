import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { AdminMemberModerationService } from './admin-member-moderation.service';
import { CiteMemberDto } from './dto/cite-member.dto';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { RestrictMemberDto } from './dto/restrict-member.dto';

/**
 * The admin member-drawer moderation actions — Verify & Restrict (P2-3). A
 * separate controller from `AdminMembersController` (admin-members module,
 * `@Roles(Admin)`) because these are moderator-capable: a moderator can verify
 * and restrict, matching `ModerationController`. Shares the `admin/members`
 * base path (different HTTP methods/subpaths, so no route clash) and lives in
 * the moderation module, next to the enforcement/audit/notification machinery
 * it reuses.
 */
@ApiTags('Admin — Member moderation')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/members')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminMemberModerationController {
  constructor(private readonly service: AdminMemberModerationService) {}

  @ApiOperation({ summary: 'Verify a member (stamps who/when).' })
  @ApiOkResponse({ description: "The member's verified state." })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Post(':id/verify')
  verify(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.verifyMember(currentUser.userId, id);
  }

  @ApiOperation({
    summary:
      'Cite evidence against a member — a free-text note attached to their audit trail (ADM-9).',
  })
  @ApiOkResponse({ description: 'The recorded citation.' })
  @ApiBadRequestResponse({ description: 'Missing or too-long note.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Post(':id/cite')
  cite(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CiteMemberDto,
  ) {
    return this.service.citeMember(currentUser.userId, id, dto.note);
  }

  @ApiOperation({
    summary:
      'Restrict a member platform-wide (suspend, or ban if no duration).',
  })
  @ApiOkResponse({ description: "The member's resulting status + expiry." })
  @ApiBadRequestResponse({ description: 'Malformed body or duration.' })
  @ApiForbiddenResponse({
    description:
      'Requires a moderator/admin role, or the target is yourself, a staff account, or the house account.',
  })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Post(':id/restrict')
  restrict(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestrictMemberDto,
  ) {
    return this.service.restrictMember(currentUser.userId, id, dto);
  }

  @ApiOperation({
    summary:
      "Read a member's scoped restriction (users.restricted), so the drawer knows whether there is one to lift.",
  })
  @ApiOkResponse({ description: "The member's restriction state." })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Get(':id/restriction')
  restriction(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.restrictionState(id);
  }

  /**
   * The way back out of a `restrict`, which had none: the only route was
   * winning an appeal, or waiting for `restricted_until` to lapse (TS-09).
   * Mirrors `PATCH /mod/users/:userId/suspension` — a PATCH, idempotent,
   * audited, and it tells the member.
   */
  @ApiOperation({ summary: "Lift a member's scoped restriction." })
  @ApiOkResponse({
    description:
      "The member's resulting restriction state. Idempotent: lifting a restriction that is not in force is a no-op, not a 409.",
  })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Patch(':id/restriction')
  liftRestriction(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LiftRestrictionDto,
  ) {
    return this.service.liftRestriction(currentUser.userId, id, dto);
  }
}
