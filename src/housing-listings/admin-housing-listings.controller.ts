import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { HousingModerationGuard } from '../auth/guards/housing-moderation.guard';
import { Feature } from '../common/feature.decorator';
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
 * listings precedent so moderators can clear the review queue), OR a member
 * holding the additive `housing_moderator` staff role (see
 * `HousingModerationGuard`).
 */
@Feature('housingListings')
@ApiTags('Admin — Housing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated.',
})
@ApiForbiddenResponse({
  description:
    'Requires moderator or admin role, or the housing_moderator staff role.',
})
@Controller('admin/housing-listings')
@UseGuards(ActiveMemberGuard, HousingModerationGuard)
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
