import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioListeningRangeQuery } from './dto/studio-listening-range.query';
import { StudioAccessGuard } from './studio-access.guard';
import {
  DEFAULT_STUDIO_LISTENING_RANGE,
  StudioListeningSummary,
  StudioListensPage,
} from './studio-listening-history';
import { StudioListeningHistoryService } from './studio-listening-history.service';
import { StudioSupportersService } from './studio-supporters.service';
import { StudioSupportingResponse } from './studio-supporters';

/** The listener's own history and the artists they support. */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('me')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioListeningHistoryController {
  constructor(
    private readonly history: StudioListeningHistoryService,
    private readonly supporters: StudioSupportersService,
  ) {}

  @Get('studio-listening')
  @ApiOperation({ summary: "The caller's listening summary for a range." })
  @ApiOkResponse({ description: '`StudioListeningSummary`.' })
  getSummary(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StudioListeningRangeQuery,
  ): Promise<StudioListeningSummary> {
    return this.history.getSummary(
      user.userId,
      query.range ?? DEFAULT_STUDIO_LISTENING_RANGE,
    );
  }

  @Get('studio-listening/recent')
  @ApiOperation({ summary: "The caller's recent listens, newest first." })
  @ApiOkResponse({ description: '`StudioListensPage`.' })
  listRecent(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioListensPage> {
    return this.history.listRecent(user.userId, query.cursor);
  }

  @Delete('studio-listening')
  @HttpCode(204)
  @ApiOperation({ summary: "Deletes the caller's listening history." })
  @ApiNoContentResponse({ description: 'The history is empty.' })
  async clearHistory(@CurrentUser() user: CurrentUserData): Promise<void> {
    await this.history.clearHistory(user.userId);
  }

  @Get('studio-listening/supporting')
  @ApiOperation({ summary: 'The artists the caller supports.' })
  @ApiOkResponse({ description: '`StudioSupportingResponse`.' })
  listSupporting(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioSupportingResponse> {
    return this.supporters.listSupporting(user.userId);
  }
}
