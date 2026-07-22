import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { BrowseHousingListingsQuery } from './dto/browse-housing-listings.query';
import { HousingDirectoryService } from './housing-directory.service';

/**
 * Member-only housing board browse + detail over LIVE listings only, on its
 * own top-level `/housing-directory` path.
 */
@Feature('housingListings')
@UseGuards(ActiveMemberGuard)
@Controller('housing-directory')
export class HousingDirectoryController {
  constructor(private readonly service: HousingDirectoryService) {}

  @Get()
  browse(@Query() query: BrowseHousingListingsQuery) {
    return this.service.browse(query);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.service.detail(slug);
  }
}
