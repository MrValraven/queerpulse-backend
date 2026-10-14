import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { StudioAccessGuard } from './studio-access.guard';
import { StudioCreditsInboxService } from './studio-credits-inbox.service';
import {
  StudioCreditInbox,
  StudioCreditInboxRow,
  StudioCreditPendingCount,
} from './studio-persona-credit-response';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/credits')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioCreditsInboxController {
  constructor(private readonly inbox: StudioCreditsInboxService) {}

  @Get('inbox')
  @ApiOperation({ summary: 'Credit requests and accepted credits.' })
  @ApiOkResponse({ description: '`StudioCreditInbox`.' })
  getInbox(@CurrentUser() user: CurrentUserData): Promise<StudioCreditInbox> {
    return this.inbox.getInbox(user.userId);
  }

  @Get('pending-count')
  @ApiOperation({ summary: 'How many credit requests wait, for the badge.' })
  @ApiOkResponse({ description: '`StudioCreditPendingCount`.' })
  pendingCount(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioCreditPendingCount> {
    return this.inbox.pendingCount(user.userId);
  }

  @Post(':id/accept')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a credit request.' })
  @ApiOkResponse({ description: '`StudioCreditInboxRow`, now accepted.' })
  @ApiNotFoundResponse({ description: '`studio_credit_not_found`.' })
  @ApiConflictResponse({ description: '`studio_credit_not_pending`.' })
  accept(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) creditId: string,
  ): Promise<StudioCreditInboxRow> {
    return this.inbox.accept(user.userId, creditId);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline a credit request; nothing is sent.' })
  @ApiNoContentResponse({ description: 'Declined.' })
  @ApiNotFoundResponse({ description: '`studio_credit_not_found`.' })
  @ApiConflictResponse({ description: '`studio_credit_not_pending`.' })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) creditId: string,
  ): Promise<void> {
    return this.inbox.decline(user.userId, creditId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a credit from either side.' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: '`studio_credit_not_found`.' })
  @ApiConflictResponse({ description: '`studio_credit_not_accepted`.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) creditId: string,
  ): Promise<void> {
    return this.inbox.remove(user.userId, creditId);
  }
}
