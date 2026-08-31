import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminIdentityService } from './admin-identity.service';
import {
  ApplyRelinkDto,
  DismissRelinkDto,
  ReactivateMemberDto,
} from './dto/admin-identity.dto';

/**
 * The account-recovery levers on the member console: re-link a member's Google
 * sign-in identity (PRD-06) and reactivate a member stranded in `Deactivated`
 * (PRD-11).
 *
 * ADMIN ONLY, and narrower than the rest of the console on purpose. The
 * neighbouring `AdminMemberModerationController` is `@Roles(Moderator, Admin)`
 * because verifying and restricting are moderator work. Nothing here is:
 * re-linking decides who controls an account, and reactivating writes
 * `users.status` directly. The empty `@StaffRoles()` is the explicit form of
 * "no additive grant opens this either" (see `RolesOrStaffGuard`) so a future
 * staff role can never widen these two routes by accident.
 *
 * Deliberately NOT `@LockdownExempt()`, mirroring `AdminMembersController`:
 * nothing here lifts a lockdown, so it goes dark with everything else.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles()
@ApiTags('Admin — Member identity')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/members')
export class AdminMemberIdentityController {
  constructor(private readonly identity: AdminIdentityService) {}

  @ApiOperation({
    summary:
      "A member's account-recovery panel: the Google identities that have presented their verified address, and whether either lever is open.",
  })
  @ApiOkResponse({ description: 'The account-recovery panel.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Get(':memberId/account-recovery')
  getAccountRecovery(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.identity.getAccountRecovery(currentUser.userId, memberId);
  }

  // The body carries a reason and nothing else. The identity being linked is
  // named by `:candidateId`, which can only resolve to a row the sign-up path
  // wrote after Google asserted `email_verified` for this member's own address
  // — see the essay on `AdminIdentityService.applyRelink`. Never add a
  // `googleId` field to this route.
  @ApiOperation({
    summary:
      "Re-point a member's account at a Google identity that proved control of their address.",
  })
  @ApiOkResponse({ description: 'The applied decision.' })
  @ApiBadRequestResponse({ description: 'Missing or too-short reason.' })
  @ApiForbiddenResponse({
    description:
      'Requires the admin role, or the re-link is refused (own account, a house account, a staff account, or a pending erasure).',
  })
  @ApiNotFoundResponse({ description: 'Member or candidate not found.' })
  @ApiConflictResponse({
    description:
      'The candidate was already decided, the identity is now held by another account, or the member changed underneath the decision.',
  })
  @Post(':memberId/account-recovery/candidates/:candidateId/relink')
  applyRelink(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: ApplyRelinkDto,
  ) {
    return this.identity.applyRelink(
      currentUser.userId,
      memberId,
      candidateId,
      body.reason,
    );
  }

  @ApiOperation({
    summary: 'Refuse a sign-in identity candidate. Recorded, never deleted.',
  })
  @ApiOkResponse({ description: 'The dismissal.' })
  @ApiBadRequestResponse({ description: 'Missing or too-short reason.' })
  @ApiNotFoundResponse({ description: 'Member or candidate not found.' })
  @ApiConflictResponse({ description: 'The candidate was already decided.' })
  @Post(':memberId/account-recovery/candidates/:candidateId/dismiss')
  dismissRelink(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: DismissRelinkDto,
  ) {
    return this.identity.dismissRelink(
      currentUser.userId,
      memberId,
      candidateId,
      body.reason,
    );
  }

  @ApiOperation({
    summary:
      'Reactivate a member left deactivated with no open deactivation row.',
  })
  @ApiOkResponse({ description: 'The restored member.' })
  @ApiBadRequestResponse({ description: 'Missing or too-short reason.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @ApiConflictResponse({
    description:
      'The member is not deactivated, paused their own account, asked to be erased, or is under a live suspension.',
  })
  @Post(':memberId/account-recovery/reactivate')
  reactivate(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: ReactivateMemberDto,
  ) {
    return this.identity.reactivateMember(
      currentUser.userId,
      memberId,
      body.reason,
    );
  }
}
