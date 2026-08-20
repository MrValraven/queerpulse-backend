import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { RateGuideDto } from './dto/rate-guide.dto';
import { ResourceGuideRatingsService } from './resource-guide-ratings.service';

// "Was this guide helpful?" (CNT-18). Split from `ResourcesController` the
// same way `GlossaryController` is — a distinct resource under the same
// `resources` feature flag, sharing the module but not the service.
@Feature('resources')
@ApiTags('Resources — Guide ratings')
@ApiCookieAuth('access_token')
@Controller('resources/guides')
@UseGuards(ActiveMemberGuard)
export class ResourceGuideRatingsController {
  constructor(private readonly ratings: ResourceGuideRatingsService) {}

  @Get(':contentKey/rating')
  @ApiOperation({
    summary: 'Get aggregate rating + the caller vote for a guide section',
  })
  @ApiOkResponse({
    description: 'Aggregate helpful/not-helpful counts and the caller vote.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  get(
    @Param('contentKey') contentKey: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.ratings.getForContentKey(contentKey, user.userId);
  }

  @Post(':contentKey/rating')
  @ApiOperation({
    summary: 'Cast or toggle a helpful/not-helpful vote on a guide section',
  })
  @ApiCreatedResponse({
    description: 'Updated aggregate counts and the caller new vote.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  rate(
    @Param('contentKey') contentKey: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RateGuideDto,
  ) {
    return this.ratings.rate(contentKey, user.userId, dto.value);
  }
}
