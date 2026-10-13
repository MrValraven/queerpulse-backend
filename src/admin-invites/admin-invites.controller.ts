import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AdminInviteDTO } from './admin-invites-response';
import { AdminInvitesService } from './admin-invites.service';
import { ListAdminInvitesQuery } from './dto/list-admin-invites.query';

/**
 * Admin oversight of the invite graph platform-wide: every invite ever minted,
 * filterable by resolved status / invitee email / a single inviter, paginated.
 *
 * Guarded exactly like `AdminMembersController` — `ActiveMemberGuard` +
 * `RolesGuard` with `@Roles(Admin)` — and deliberately NOT `@LockdownExempt()`,
 * so this surface goes dark with the rest of the admin dashboard.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Invites')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/invites')
export class AdminInvitesController {
  constructor(private readonly adminInvites: AdminInvitesService) {}

  @ApiOperation({
    summary: 'Every member who has sent an invite, for the sender filter.',
  })
  @ApiOkResponse({ description: 'Distinct inviters with their invite counts.' })
  @Get('inviters')
  listInviters() {
    return this.adminInvites.listInviters();
  }

  @ApiOperation({
    summary: 'List platform-wide invites (paginated, filterable).',
  })
  @ApiOkResponse({ description: 'One page of invites.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get()
  list(@Query() query: ListAdminInvitesQuery) {
    return this.adminInvites.list(query);
  }

  /**
   * Revoke any still-valid invite platform-wide. The member route
   * (`DELETE /invites/:code`) is scoped to the inviter, so this is the only way
   * staff can pull someone else's live invite link.
   *
   * Addressed by the internal `id` the admin list already returns, never the
   * shared `code` — a code is a credential that gets pasted into chats, and an
   * admin surface has no reason to take one. `ParseUUIDPipe` answers 400 for a
   * malformed id; an unknown one is a 404.
   */
  @ApiOperation({ summary: 'Revoke a still-valid invite (admin, audited).' })
  @ApiOkResponse({ description: 'The invite, now revoked.' })
  @ApiNotFoundResponse({ description: 'No invite with that id.' })
  @ApiConflictResponse({
    description:
      'The invite is not valid any more (already accepted, revoked, or expired).',
  })
  @Delete(':id')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() current: CurrentUserData,
  ): Promise<AdminInviteDTO> {
    return this.adminInvites.revoke(id, current.userId);
  }

  /**
   * Refresh any expired invite platform-wide. The member route
   * (`POST /invites/:code/resend`) is scoped to the inviter, so this is how
   * staff give someone else's lapsed invite another 7 days. Same row, same
   * code, so the link already shared starts working again, and the inviter's
   * monthly quota is left alone.
   *
   * Addressed by the internal `id`, like the revoke route above. `@HttpCode(200)`
   * because it returns the updated row and creates nothing.
   */
  @ApiOperation({ summary: 'Refresh an expired invite (admin, audited).' })
  @ApiOkResponse({ description: 'The invite, valid again for another 7 days.' })
  @ApiNotFoundResponse({ description: 'No invite with that id.' })
  @ApiConflictResponse({
    description:
      'Only an expired invite can be refreshed (it was accepted, revoked, or is still valid).',
  })
  @Post(':id/refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() current: CurrentUserData,
  ): Promise<AdminInviteDTO> {
    return this.adminInvites.refresh(id, current.userId);
  }
}
