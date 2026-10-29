import { Controller, Get, UseGuards } from '@nestjs/common';
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
import { Feature } from '../common/feature.decorator';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioCuration,
  StudioCurationService,
} from './studio-curation.service';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioCurationController {
  constructor(private readonly curation: StudioCurationService) {}

  @Get('curation')
  @ApiOperation({
    summary:
      'The featured release, the two staff shelves, Artist of the month and New stars.',
  })
  @ApiOkResponse({ description: '`StudioCuration`.' })
  getCuration(@CurrentUser() user: CurrentUserData): Promise<StudioCuration> {
    return this.curation.getCuration(user.userId);
  }
}
