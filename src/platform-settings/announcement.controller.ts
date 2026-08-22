import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
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
import { AnnouncementDismissalService } from './announcement-dismissal.service';

/**
 * Member-facing dismiss endpoint for the sitewide announcement banner
 * (ADM-25). Signed-out visitors never reach this — they dismiss locally via
 * `localStorage`, keyed by the same version. See `AnnouncementDismissal`'s
 * doc comment for why this is its own small table rather than a reuse of
 * `persona_nudges`.
 */
@ApiTags('Announcement')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Requires an authenticated session.' })
@Controller('announcement')
@UseGuards(ActiveMemberGuard)
export class AnnouncementController {
  constructor(private readonly dismissals: AnnouncementDismissalService) {}

  // Idempotent upsert. The version is the announcement's uuid, and it is
  // parsed as one: `announcement_dismissal.announcement_version` is a `uuid`
  // column, so an arbitrary string reached Postgres and raised 22P02 —
  // a 500 (logged at error level, shipped to Sentry) that any member could
  // produce at will. Dismissing a version that is no longer the current one is
  // still harmless; it just never gets read back by
  // `PlatformStatusController`.
  @Post(':version/dismiss')
  @ApiOperation({ summary: 'Dismiss the announcement banner for good.' })
  @ApiOkResponse({ description: 'The banner is dismissed for this member.' })
  @ApiBadRequestResponse({ description: 'Malformed announcement version.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  async dismiss(
    @CurrentUser() user: CurrentUserData,
    @Param('version', ParseUUIDPipe) version: string,
  ): Promise<{ dismissed: true }> {
    await this.dismissals.dismiss(user.userId, version);
    return { dismissed: true };
  }
}
