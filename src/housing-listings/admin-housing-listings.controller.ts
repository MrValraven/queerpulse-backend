import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { UpdateHousingListingStatusDto } from './dto/update-housing-listing-status.dto';
import { HousingListingsService } from './housing-listings.service';

/**
 * Moderator/admin moderation of housing listings — list all (incl. non-live)
 * and transition status. Mirrors `ListingsController.setStatus`'s
 * Moderator+Admin gate (co-ops are Admin-only; housing listings follow the
 * listings precedent so moderators can clear the review queue).
 */
@Feature('housingListings')
@Controller('admin/housing-listings')
@UseGuards(RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminHousingListingsController {
  constructor(private readonly service: HousingListingsService) {}

  @Get()
  listAll() {
    return this.service.listAllForAdmin();
  }

  @Patch(':ref/status')
  setStatus(
    @Param('ref') ref: string,
    @Body() dto: UpdateHousingListingStatusDto,
  ) {
    return this.service.setStatus(ref, dto.status);
  }
}
