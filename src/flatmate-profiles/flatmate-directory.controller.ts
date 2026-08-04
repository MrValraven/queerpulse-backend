import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { BrowseFlatmateProfilesQuery } from './dto/browse-flatmate-profiles.query';
import { FlatmateDirectoryService } from './flatmate-directory.service';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/** Member-only flatmate board browse + detail, on its own top-level
 * `/flatmate-directory` path (avoids the `:slug` route-shadow hazard). */
@Feature('flatmateProfiles')
@UseGuards(ActiveMemberGuard)
@ApiTags('Flatmates')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('flatmate-directory')
export class FlatmateDirectoryController {
  constructor(private readonly service: FlatmateDirectoryService) {}

  @Get()
  @ApiOperation({
    summary:
      'Browse flatmate profiles (match-ranked for members with a profile)',
  })
  @ApiOkResponse({
    description:
      'Paginated flatmate profiles, best match first when applicable.',
  })
  browse(
    @CurrentUser() user: CurrentUserData,
    @Query() query: BrowseFlatmateProfilesQuery,
  ) {
    return this.service.browse(user.userId, query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a single flatmate profile by slug' })
  @ApiOkResponse({ description: 'The flatmate profile.' })
  @ApiNotFoundResponse({
    description: 'Profile not found, or hidden by a block between the members.',
  })
  detail(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.service.detail(user.userId, slug);
  }
}
