import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
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
import { StudioAccessRequestsService } from './studio-access-requests.service';
import { StudioAccessService } from './studio-access.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioMe, toStudioArtistRef } from './studio-response';

// No `StudioAccessGuard` here on purpose: this route answers
// `hasAccess: false` so the frontend can render the teaser.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard)
export class StudioMeController {
  constructor(
    private readonly access: StudioAccessService,
    private readonly ownership: StudioOwnershipService,
    private readonly accessRequests: StudioAccessRequestsService,
  ) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Whether the caller has Studio access, the personas they can upload for, their open counter-notice windows, and their waiting access request.',
  })
  @ApiOkResponse({ description: '`StudioMe`.' })
  async me(@CurrentUser() user: CurrentUserData): Promise<StudioMe> {
    const hasAccess = await this.access.hasAccess(user.userId);
    if (!hasAccess) {
      // Contract 12.2: a member without access reads their waiting request.
      const ownRequest = await this.accessRequests.findOwnRequest(user.userId);
      return {
        hasAccess,
        uploadablePersonas: [],
        counterWindowsOpen: 0,
        hasPendingRequest: ownRequest !== null,
        wantsToRelease: ownRequest?.wantsToRelease ?? false,
      };
    }
    const [personas, counterWindowsOpen] = await Promise.all([
      this.ownership.listUploadablePersonas(user.userId),
      this.ownership.countOpenCounterWindows(user.userId),
    ]);
    return {
      hasAccess,
      uploadablePersonas: personas.map(toStudioArtistRef),
      counterWindowsOpen,
      // Contract 12.2: a grant deletes the request, so both read false.
      hasPendingRequest: false,
      wantsToRelease: false,
    };
  }
}
