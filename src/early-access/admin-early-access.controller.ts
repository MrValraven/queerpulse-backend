import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { EarlyAccessAdminService } from './early-access-admin.service';
import type {
  EarlyAccessFeaturesResponse,
  EarlyAccessRosterResponse,
} from './early-access-response';

// The admin early-access roster page: who holds each feature in early access.
// Revoking from the page goes through `AdminMemberEarlyAccessController`. No
// `@Feature` tag, for the same reason as there.
@ApiTags('Admin: Early access')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/early-access')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminEarlyAccessController {
  constructor(private readonly earlyAccess: EarlyAccessAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Every feature in early access, with its grant count.',
  })
  @ApiOkResponse({ description: 'Features in registry order.' })
  listFeatures(): Promise<EarlyAccessFeaturesResponse> {
    return this.earlyAccess.listFeatures();
  }

  @Get(':feature')
  @ApiOperation({
    summary: "One feature's grant holders, newest first, capped at 200.",
  })
  @ApiOkResponse({ description: 'The roster, with the total grant count.' })
  @ApiNotFoundResponse({ description: 'Early access feature not found.' })
  roster(
    @Param('feature') featureKey: string,
  ): Promise<EarlyAccessRosterResponse> {
    return this.earlyAccess.roster(featureKey);
  }
}
