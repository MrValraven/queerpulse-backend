import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiGoneResponse,
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
import { Feature } from '../common/feature.decorator';
import { ListMyStudioPurchasesQuery } from './dto/list-my-studio-purchases.query';
import { StudioPurchaseLibraryService } from './studio-purchase-library.service';
import {
  StudioBuyerPurchase,
  StudioPurchaseDownload,
} from './studio-purchases-response';
import { StudioPage } from './studio-response';

/**
 * The buyer's purchases and their downloads (contract 3.6 and 3.7).
 * Outside the Studio gate (ruling 8), so a buyer who lost access keeps
 * their purchases.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller()
@UseGuards(ActiveMemberGuard)
export class StudioPurchaseLibraryController {
  constructor(private readonly library: StudioPurchaseLibraryService) {}

  @Get('me/studio-purchases')
  @ApiOperation({ summary: "The caller's purchases, newest first." })
  @ApiOkResponse({ description: '`StudioPage<StudioBuyerPurchase>`.' })
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyStudioPurchasesQuery,
  ): Promise<StudioPage<StudioBuyerPurchase>> {
    return this.library.listMine(user.userId, query);
  }

  @Get('studio/purchases/:purchaseId/tracks/:trackId/download')
  @ApiOperation({ summary: 'A short-lived download link for a bought track.' })
  @ApiOkResponse({ description: '`StudioPurchaseDownload`.' })
  @ApiNotFoundResponse({ description: '`studio_purchase_not_found`.' })
  @ApiConflictResponse({
    description:
      '`studio_purchase_not_confirmed`, `studio_download_track_not_ready` or `studio_download_track_preparing`.',
  })
  @ApiGoneResponse({
    description:
      '`studio_download_item_deleted`, `studio_download_track_removed`, `studio_download_release_taken_down`, `studio_download_artist_unavailable` or `studio_download_track_withheld`.',
  })
  download(
    @CurrentUser() user: CurrentUserData,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Param('trackId', ParseUUIDPipe) trackId: string,
  ): Promise<StudioPurchaseDownload> {
    return this.library.download(user.userId, purchaseId, trackId);
  }
}
