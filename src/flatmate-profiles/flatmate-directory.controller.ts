import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { BrowseFlatmateProfilesQuery } from './dto/browse-flatmate-profiles.query';
import { DecideFlatmateDto } from './dto/decide-flatmate.dto';
import { FlatmateDirectoryService } from './flatmate-directory.service';
import { FlatmateLikesService } from './flatmate-likes.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
  constructor(
    private readonly service: FlatmateDirectoryService,
    private readonly likes: FlatmateLikesService,
  ) {}

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

  @Post(':slug/decide')
  @ApiOperation({
    summary: 'Record a like/pass on a profile from the discovery deck',
  })
  @ApiCreatedResponse({
    description: 'Decision recorded; `matched` is true on a mutual like.',
  })
  @ApiBadRequestResponse({ description: 'You cannot like your own profile.' })
  @ApiNotFoundResponse({ description: 'Flatmate profile not found.' })
  decide(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: DecideFlatmateDto,
  ) {
    return this.likes.decide(user.userId, slug, dto.decision);
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
