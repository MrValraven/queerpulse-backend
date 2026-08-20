import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
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

  // Idempotent upsert; any string is accepted as a version — dismissing a
  // version that is no longer the current one is harmless (it just never
  // gets read back by `PlatformStatusController`).
  @Post(':version/dismiss')
  @ApiOperation({ summary: 'Dismiss the announcement banner for good.' })
  @ApiOkResponse({ description: 'The banner is dismissed for this member.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  async dismiss(
    @CurrentUser() user: CurrentUserData,
    @Param('version') version: string,
  ): Promise<{ dismissed: true }> {
    await this.dismissals.dismiss(user.userId, version);
    return { dismissed: true };
  }
}
