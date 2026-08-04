import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { UpdateHousingListingStatusDto } from './dto/update-housing-listing-status.dto';
import { HousingListingsService } from './housing-listings.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Moderator/admin moderation of housing listings — list all (incl. non-live)
 * and transition status. Mirrors `ListingsController.setStatus`'s
 * Moderator+Admin gate (co-ops are Admin-only; housing listings follow the
 * listings precedent so moderators can clear the review queue).
 */
@Feature('housingListings')
@ApiTags('Admin — Housing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated.',
})
@ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
@Controller('admin/housing-listings')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminHousingListingsController {
  constructor(private readonly service: HousingListingsService) {}

  @Get()
  @ApiOperation({ summary: 'List all housing listings (including non-live)' })
  @ApiOkResponse({ description: 'Every housing listing, for moderation.' })
  listAll() {
    return this.service.listAllForAdmin();
  }

  @Patch(':ref/status')
  @ApiOperation({ summary: "Set a housing listing's moderation status" })
  @ApiOkResponse({ description: 'The updated housing listing.' })
  @ApiNotFoundResponse({ description: 'Housing listing not found.' })
  setStatus(
    @Param('ref') ref: string,
    @Body() dto: UpdateHousingListingStatusDto,
  ) {
    return this.service.setStatus(ref, dto.status);
  }
}
