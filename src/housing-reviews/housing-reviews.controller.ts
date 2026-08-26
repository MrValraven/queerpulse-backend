import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { SubmitHousingReviewDto } from './dto/submit-housing-review.dto';
import { HousingReviewsService } from './housing-reviews.service';

/**
 * Two-sided blind reviews for housing viewings. Submitting requires a completed
 * viewing the caller took part in; reads apply the blind-reveal rule so a
 * review is never disclosed to the counterparty before it has unlocked.
 */
@Feature('housingListings')
@ApiTags('Housing reviews')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
@Controller('housing-reviews')
@UseGuards(ActiveMemberGuard)
export class HousingReviewsController {
  constructor(private readonly service: HousingReviewsService) {}

  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Submit a review after a completed viewing' })
  @ApiCreatedResponse({ description: "The caller's own submitted review." })
  submit(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SubmitHousingReviewDto,
  ) {
    return this.service.submit(user.userId, dto);
  }

  @Get('viewing/:viewingId')
  @ApiOperation({
    summary: 'The blind-review pair for a viewing (from the caller)',
  })
  @ApiOkResponse({
    description: 'Your review + the counterparty (if revealed).',
  })
  forViewing(
    @CurrentUser() user: CurrentUserData,
    // BE-HSG-10: a non-UUID segment used to reach a `uuid` column comparison
    // and surface as a 500 (Postgres 22P02 through TypeORM's QueryFailedError,
    // which `AllExceptionsFilter` cannot map). Now a 400.
    @Param('viewingId', ParseUUIDPipe) viewingId: string,
  ) {
    return this.service.forViewing(viewingId, user.userId);
  }

  @Get('listing/:slug')
  @ApiOperation({
    summary: 'Public revealed reviews + average for a listing',
  })
  @ApiOkResponse({
    description: 'Aggregate rating and revealed guest reviews.',
  })
  forListing(@Param('slug') slug: string) {
    return this.service.forListing(slug);
  }
}
