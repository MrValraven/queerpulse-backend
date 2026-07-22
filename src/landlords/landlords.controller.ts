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

/**
 * Member-facing community landlord directory. Browse/detail are member-only
 * over LIVE entries; `POST /` suggests an entry (→ review). No route collision:
 * `GET /:slug` is 1-segment; the `POST /:slug/*` routes differ by verb + depth.
 */
@Feature('landlords')
@Controller('landlords')
@UseGuards(ActiveMemberGuard)
export class LandlordsController {
  constructor(private readonly service: LandlordsService) {}

  @Get()
  browse(@Query() query: BrowseLandlordsQuery) {
    return this.service.browse(query);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.service.detail(slug);
  }

  @Post()
  suggest(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateLandlordDto,
  ) {
    return this.service.suggest(user.userId, dto);
  }

  @Post(':slug/recommendations')
  recommend(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateRecommendationDto,
  ) {
    return this.service.recommend(slug, user.userId, dto);
  }

  @Post(':slug/intro-requests')
  introRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateIntroRequestDto,
  ) {
    return this.service.createIntroRequest(slug, user.userId, dto);
  }
}
