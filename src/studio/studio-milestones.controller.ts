import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { StudioAccessGuard } from './studio-access.guard';
import { StudioArtistMilestonesService } from './studio-artist-milestones.service';
import { StudioMilestoneCardResponse } from './studio-milestones';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/milestones')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioMilestonesController {
  constructor(private readonly milestones: StudioArtistMilestonesService) {}

  @Get(':milestoneId')
  @ApiOperation({ summary: 'The share card of one artist milestone.' })
  @ApiOkResponse({ description: '`StudioMilestoneCardResponse`.' })
  @ApiNotFoundResponse({
    description: '`studio_milestone_not_found`, for every cause.',
  })
  getMilestoneCard(
    @CurrentUser() user: CurrentUserData,
    // The id is read as typed, so a malformed id answers the same 404.
    @Param('milestoneId') milestoneId: string,
  ): Promise<StudioMilestoneCardResponse> {
    return this.milestones.getMilestoneCard(user.userId, milestoneId);
  }
}
