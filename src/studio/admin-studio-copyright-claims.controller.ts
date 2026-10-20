import {
  Body,
  Controller,
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
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { DecideStudioClaimDto } from './dto/decide-studio-claim.dto';
import { ListAdminStudioClaimsQuery } from './dto/list-admin-studio-claims.query';
import {
  StudioAdminClaim,
  StudioAdminClaimCounts,
} from './studio-claim-response';
import { StudioClaimsAdminService } from './studio-claims-admin.service';
import { StudioPage } from './studio-response';

// Studio safety and moderation: the flag review's Claims tab. No Studio
// grant needed, like the other Studio staff routes.
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/copyright-claims')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioCopyrightClaimsController {
  constructor(private readonly adminClaims: StudioClaimsAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Claims by status, oldest first; no status is the work queue.',
  })
  @ApiOkResponse({ description: '`StudioPage<StudioAdminClaim>`.' })
  listClaims(
    @Query() query: ListAdminStudioClaimsQuery,
  ): Promise<StudioPage<StudioAdminClaim>> {
    return this.adminClaims.list(query.status, query.cursor);
  }

  // Declared before the `:id` routes.
  @Get('counts')
  @ApiOperation({ summary: 'Submitted and countered claims, for the badge.' })
  @ApiOkResponse({ description: '`StudioAdminClaimCounts`.' })
  countClaims(): Promise<StudioAdminClaimCounts> {
    return this.adminClaims.counts();
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a claim: the track goes offline.' })
  @ApiOkResponse({ description: '`StudioAdminClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({ description: '`studio_claim_not_submitted`.' })
  accept(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
  ): Promise<StudioAdminClaim> {
    return this.adminClaims.accept(user.userId, claimId);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a claim at the check, with a note.' })
  @ApiOkResponse({ description: '`StudioAdminClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({ description: '`studio_claim_not_submitted`.' })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
    @Body() body: DecideStudioClaimDto,
  ): Promise<StudioAdminClaim> {
    return this.adminClaims.decline(user.userId, claimId, body.note);
  }

  @Post(':id/uphold')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Uphold a claim: the track stays offline.' })
  @ApiOkResponse({ description: '`StudioAdminClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({ description: '`studio_claim_not_decidable`.' })
  uphold(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
    @Body() body: DecideStudioClaimDto,
  ): Promise<StudioAdminClaim> {
    return this.adminClaims.uphold(user.userId, claimId, body.note);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reject a claim: the track comes back unless another claim holds it.',
  })
  @ApiOkResponse({ description: '`StudioAdminClaim`.' })
  @ApiNotFoundResponse({ description: 'Claim not found.' })
  @ApiConflictResponse({ description: '`studio_claim_not_decidable`.' })
  reject(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) claimId: string,
    @Body() body: DecideStudioClaimDto,
  ): Promise<StudioAdminClaim> {
    return this.adminClaims.reject(user.userId, claimId, body.note);
  }
}
