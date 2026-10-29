import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
import { DeclineStudioPurchaseDto } from './dto/decline-studio-purchase.dto';
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioSalesPendingCount,
  StudioSalesTotals,
  StudioSellerPurchase,
} from './studio-purchases-response';
import { StudioPage } from './studio-response';
import { StudioSalesService } from './studio-sales.service';

/** The artist side of Studio purchases (contract 3.8 to 3.11): claims to
 *  confirm, decisions, sales and the pending badge. */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioSalesController {
  constructor(private readonly sales: StudioSalesService) {}

  @Get('artists/:subprofileId/purchases')
  @ApiOperation({
    summary: 'Payment claims waiting for the artist, oldest first.',
  })
  @ApiOkResponse({ description: '`StudioPage<StudioSellerPurchase>`.' })
  @ApiNotFoundResponse({ description: '`studio_persona_not_found`.' })
  listToConfirm(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<StudioSellerPurchase>> {
    return this.sales.listToConfirm(user.userId, subprofileId, query.cursor);
  }

  @Post('artists/:subprofileId/purchases/:purchaseId/confirm')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirms the payment arrived.' })
  @ApiNoContentResponse({ description: 'Confirmed.' })
  @ApiForbiddenResponse({ description: '`ACCOUNT_RESTRICTED`.' })
  @ApiNotFoundResponse({
    description: '`studio_persona_not_found` or `studio_purchase_not_found`.',
  })
  @ApiConflictResponse({ description: '`studio_purchase_not_pending`.' })
  confirm(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
  ): Promise<void> {
    return this.sales.confirm(user.userId, subprofileId, purchaseId);
  }

  @Post('artists/:subprofileId/purchases/:purchaseId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Declines a payment claim with a reason.' })
  @ApiNoContentResponse({ description: 'Declined.' })
  @ApiNotFoundResponse({
    description: '`studio_persona_not_found` or `studio_purchase_not_found`.',
  })
  @ApiConflictResponse({ description: '`studio_purchase_not_pending`.' })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: DeclineStudioPurchaseDto,
  ): Promise<void> {
    return this.sales.decline(user.userId, subprofileId, purchaseId, body);
  }

  @Get('artists/:subprofileId/sales')
  @ApiOperation({ summary: 'Confirmed sales, newest decision first.' })
  @ApiOkResponse({ description: '`StudioPage<StudioSellerPurchase>`.' })
  @ApiNotFoundResponse({ description: '`studio_persona_not_found`.' })
  listSales(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<StudioSellerPurchase>> {
    return this.sales.listSales(user.userId, subprofileId, query.cursor);
  }

  @Get('artists/:subprofileId/sales/totals')
  @ApiOperation({ summary: 'Sales totals for the last 28 days and all time.' })
  @ApiOkResponse({ description: '`StudioSalesTotals`.' })
  @ApiNotFoundResponse({ description: '`studio_persona_not_found`.' })
  salesTotals(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioSalesTotals> {
    return this.sales.totals(user.userId, subprofileId);
  }

  @Get('sales/pending-count')
  @ApiOperation({
    summary: 'Payment claims waiting on every artist the caller runs.',
  })
  @ApiOkResponse({ description: '`StudioSalesPendingCount`.' })
  pendingCount(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioSalesPendingCount> {
    return this.sales.pendingCount(user.userId);
  }
}
