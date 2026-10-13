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
  ) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Whether the caller has Studio access, and the personas they can upload for.',
  })
  @ApiOkResponse({ description: '`StudioMe`.' })
  async me(@CurrentUser() user: CurrentUserData): Promise<StudioMe> {
    const hasAccess = await this.access.hasAccess(user.userId);
    if (!hasAccess) {
      return { hasAccess, uploadablePersonas: [] };
    }
    const personas = await this.ownership.listUploadablePersonas(user.userId);
    return { hasAccess, uploadablePersonas: personas.map(toStudioArtistRef) };
  }
}
