import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { BrowseHousingListingsQuery } from './dto/browse-housing-listings.query';
import { HousingDirectoryService } from './housing-directory.service';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Member-only housing board browse + detail over LIVE listings only, on its
 * own top-level `/housing-directory` path.
 */
@Feature('housingListings')
@UseGuards(ActiveMemberGuard)
@ApiTags('Housing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('housing-directory')
export class HousingDirectoryController {
  constructor(private readonly service: HousingDirectoryService) {}

  @Get()
  @ApiOperation({ summary: 'Browse live housing listings (paginated)' })
  @ApiOkResponse({ description: 'A page of live housing listings.' })
  browse(@Query() query: BrowseHousingListingsQuery) {
    return this.service.browse(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a single live housing listing by slug' })
  @ApiOkResponse({ description: 'The housing listing.' })
  @ApiNotFoundResponse({ description: 'Housing listing not found.' })
  detail(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    // viewerId drives the address-privacy gate: the exact point/address are
    // returned only to the owner or a mutually-connected member.
    return this.service.detail(slug, user.userId);
  }
}
