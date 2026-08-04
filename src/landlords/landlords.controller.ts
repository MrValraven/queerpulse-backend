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
import { BrowseLandlordsQuery } from './dto/browse-landlords.query';
import { CreateIntroRequestDto } from './dto/create-intro-request.dto';
import { CreateLandlordDto } from './dto/create-landlord.dto';
import { CreateRecommendationDto } from './dto/create-recommendation.dto';
import { LandlordsService } from './landlords.service';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Member-facing community landlord directory. Browse/detail are member-only
 * over LIVE entries; `POST /` suggests an entry (→ review). No route collision:
 * `GET /:slug` is 1-segment; the `POST /:slug/*` routes differ by verb + depth.
 */
@Feature('landlords')
@ApiTags('Landlords')
@ApiCookieAuth()
@Controller('landlords')
@UseGuards(ActiveMemberGuard)
export class LandlordsController {
  constructor(private readonly service: LandlordsService) {}

  @Get()
  @ApiOperation({ summary: 'Browse the live community landlord directory' })
  @ApiOkResponse({ description: 'Matching live landlord cards.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  browse(@Query() query: BrowseLandlordsQuery) {
    return this.service.browse(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a live landlord by slug' })
  @ApiOkResponse({ description: 'The landlord detail.' })
  @ApiNotFoundResponse({ description: 'No live landlord with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  detail(@Param('slug') slug: string) {
    return this.service.detail(slug);
  }

  @Post()
  @ApiOperation({ summary: 'Suggest a landlord directory entry for review' })
  @ApiCreatedResponse({ description: 'The suggested landlord entry.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique landlord slug.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  suggest(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateLandlordDto,
  ) {
    return this.service.suggest(user.userId, dto);
  }

  @Post(':slug/recommendations')
  @ApiOperation({
    summary: 'Recommend a landlord (creates or updates your rating)',
  })
  @ApiCreatedResponse({ description: 'The saved recommendation.' })
  @ApiNotFoundResponse({ description: 'No live landlord with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  recommend(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateRecommendationDto,
  ) {
    return this.service.recommend(slug, user.userId, dto);
  }

  @Post(':slug/intro-requests')
  @ApiOperation({ summary: 'Request an introduction to a landlord' })
  @ApiCreatedResponse({
    description: 'The created intro request id and status.',
  })
  @ApiNotFoundResponse({ description: 'No live landlord with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  introRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateIntroRequestDto,
  ) {
    return this.service.createIntroRequest(slug, user.userId, dto);
  }
}
