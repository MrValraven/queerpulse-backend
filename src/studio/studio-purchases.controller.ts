import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateStudioPurchaseDto } from './dto/create-studio-purchase.dto';
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { UpdateStudioPurchaseWallDto } from './dto/update-studio-purchase-wall.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPurchaseWallService } from './studio-purchase-wall.service';
import {
  StudioBuyerPurchase,
  StudioOffer,
  StudioPurchaseReference,
  StudioPurchaseWallState,
  StudioWallEntry,
} from './studio-purchases-response';
import { StudioPurchasesService } from './studio-purchases.service';
import { StudioPage } from './studio-response';

/** The buyer side of Studio purchases (contract 3.1 to 3.5 and 4.4): offers,
 *  the "I've paid" claim, cancelling it, the wall choice and a release's
 *  supporter wall. */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPurchasesController {
  constructor(
    private readonly purchases: StudioPurchasesService,
    private readonly wall: StudioPurchaseWallService,
  ) {}

  @Get('releases/:releaseId/offer')
  @ApiOperation({ summary: 'What buying a release looks like for the caller.' })
  @ApiOkResponse({ description: '`StudioOffer` with `trackOffers`.' })
  @ApiNotFoundResponse({ description: '`studio_purchase_item_not_found`.' })
  releaseOffer(
    @CurrentUser() user: CurrentUserData,
    @Param('releaseId', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioOffer> {
    return this.purchases.releaseOffer(user.userId, releaseId);
  }

  @Get('tracks/:trackId/offer')
  @ApiOperation({ summary: 'What buying a track looks like for the caller.' })
  @ApiOkResponse({ description: '`StudioOffer`.' })
  @ApiNotFoundResponse({ description: '`studio_purchase_item_not_found`.' })
  trackOffer(
    @CurrentUser() user: CurrentUserData,
    @Param('trackId', ParseUUIDPipe) trackId: string,
  ): Promise<StudioOffer> {
    return this.purchases.trackOffer(user.userId, trackId);
  }

  @Post('purchases/reference-code')
  @Throttle({ default: { limit: 30, ttl: seconds(3600) } })
  @ApiOperation({
    summary: 'A fresh payment code and its signed token; stores nothing.',
  })
  @ApiCreatedResponse({ description: '`StudioPurchaseReference`.' })
  issueReference(
    @CurrentUser() user: CurrentUserData,
  ): StudioPurchaseReference {
    return this.purchases.issueReference(user.userId);
  }

  @Post('purchases')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(3600) } })
  @ApiOperation({ summary: 'Tells the artist the caller paid ("I\'ve paid").' })
  @ApiCreatedResponse({ description: '`StudioBuyerPurchase`, pending.' })
  @ApiBadRequestResponse({
    description:
      '`studio_purchase_item_required` or `studio_purchase_reference_invalid`.',
  })
  @ApiForbiddenResponse({
    description:
      '`studio_purchase_own_persona`, `studio_purchase_unavailable`, `studio_supporter_identity_not_yours` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiNotFoundResponse({ description: '`studio_purchase_item_not_found`.' })
  @ApiConflictResponse({
    description:
      '`studio_purchase_already_owned`, `studio_purchase_not_for_sale`, `studio_release_type_not_for_sale`, `studio_purchase_release_not_published`, `studio_purchase_track_unavailable`, `studio_purchase_no_payment_methods`, `studio_purchase_price_changed` (with `price`), `studio_purchase_pending_exists` or `studio_purchase_reference_taken`.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`studio_purchase_amount_below_minimum` or `studio_purchase_amount_above_cap`.',
  })
  createPurchase(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioPurchaseDto,
  ): Promise<StudioBuyerPurchase> {
    return this.purchases.create(user.userId, body);
  }

  @Post('purchases/:purchaseId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancels a pending purchase of the caller.' })
  @ApiNoContentResponse({ description: 'Cancelled.' })
  @ApiNotFoundResponse({ description: '`studio_purchase_not_found`.' })
  @ApiConflictResponse({ description: '`studio_purchase_not_pending`.' })
  cancelPurchase(
    @CurrentUser() user: CurrentUserData,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
  ): Promise<void> {
    return this.purchases.cancel(user.userId, purchaseId);
  }

  @Get('purchases/:purchaseId/wall')
  @ApiOperation({ summary: "The purchase's supporter wall choice." })
  @ApiOkResponse({ description: '`StudioPurchaseWallState`.' })
  @ApiNotFoundResponse({ description: '`studio_purchase_not_found`.' })
  getWall(
    @CurrentUser() user: CurrentUserData,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
  ): Promise<StudioPurchaseWallState> {
    return this.purchases.getWall(user.userId, purchaseId);
  }

  @Put('purchases/:purchaseId/wall')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Turns the wall entry on or off, or changes its identity.',
  })
  @ApiOkResponse({ description: '`StudioPurchaseWallState`, freshly saved.' })
  @ApiForbiddenResponse({
    description:
      '`studio_supporter_identity_not_yours` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiNotFoundResponse({ description: '`studio_purchase_not_found`.' })
  @ApiConflictResponse({ description: '`studio_purchase_wall_not_available`.' })
  updateWall(
    @CurrentUser() user: CurrentUserData,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: UpdateStudioPurchaseWallDto,
  ): Promise<StudioPurchaseWallState> {
    return this.purchases.updateWall(user.userId, purchaseId, body);
  }

  @Get('releases/:releaseId/wall')
  @ApiOperation({ summary: "A release's supporter wall, 24 per page." })
  @ApiOkResponse({ description: '`StudioPage<StudioWallEntry>`.' })
  @ApiNotFoundResponse({ description: '`studio_purchase_item_not_found`.' })
  listReleaseWall(
    @CurrentUser() user: CurrentUserData,
    @Param('releaseId', ParseUUIDPipe) releaseId: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<StudioWallEntry>> {
    return this.wall.listWall(user.userId, releaseId, query.cursor);
  }
}
