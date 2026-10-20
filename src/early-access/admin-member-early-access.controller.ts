import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { EarlyAccessAdminService } from './early-access-admin.service';
import type {
  EarlyAccessGrantResponse,
  MemberEarlyAccessResponse,
} from './early-access-response';

// The member drawer's early-access toggles. Shares the `admin/members` prefix
// with `AdminMembersController` (Admin only), `AdminMemberIdentityController`,
// `AdminMemberModerationController` and `AdminStudioAccessController`; none of
// them serves `:id/early-access`. No `@Feature` tag: these routes manage access
// to unlaunched features, so they must stay reachable while those features are
// hidden.
@ApiTags('Admin: Early access')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/members')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminMemberEarlyAccessController {
  constructor(private readonly earlyAccess: EarlyAccessAdminService) {}

  @Get(':id/early-access')
  @ApiOperation({
    summary:
      "A member's grant for each feature in early access, in registry order.",
  })
  @ApiOkResponse({
    description: 'One entry per feature in early access, grant or null.',
  })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  listForMember(
    @Param('id', ParseUUIDPipe) memberId: string,
  ): Promise<MemberEarlyAccessResponse> {
    return this.earlyAccess.listForMember(memberId);
  }

  // Granting is admin only; moderators can view and revoke. `RolesGuard`
  // reads handler metadata before class metadata, so this narrows the class
  // `@Roles(Moderator, Admin)` for this route alone.
  @Put(':id/early-access/:feature')
  @Roles(UserRole.Admin)
  @HttpCode(HttpStatus.OK)
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiOperation({
    summary: 'Grant a member early access to one feature (idempotent).',
  })
  @ApiOkResponse({ description: 'The grant.' })
  @ApiNotFoundResponse({
    description: 'Member not found, or the feature is not in early access.',
  })
  grant(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) memberId: string,
    @Param('feature') featureKey: string,
  ): Promise<EarlyAccessGrantResponse> {
    return this.earlyAccess.grant(user.userId, memberId, featureKey);
  }

  @Delete(':id/early-access/:feature')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Revoke a member's early access to one feature (idempotent).",
  })
  @ApiNoContentResponse({ description: 'Early access revoked.' })
  @ApiNotFoundResponse({
    description: 'Member not found, or the feature is not in early access.',
  })
  revoke(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) memberId: string,
    @Param('feature') featureKey: string,
  ): Promise<void> {
    return this.earlyAccess.revoke(user.userId, memberId, featureKey);
  }
}
