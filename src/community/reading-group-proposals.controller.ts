import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateReadingGroupProposalDto } from './dto/create-reading-group-proposal.dto';
import { ReadingGroupProposalsService } from './reading-group-proposals.service';

// The Reading Groups page (`ReadingGroupsPage.tsx`) lists curated groups with
// no server-backed directory of its own. The one genuine piece of
// member-submitted data on the page is "Start your own group"
// (`ListGroupStrip.tsx`) — this controller is that, and only that.
@Feature('community')
@Controller('reading-groups')
@UseGuards(ActiveMemberGuard)
export class ReadingGroupProposalsController {
  constructor(
    private readonly readingGroupProposalsService: ReadingGroupProposalsService,
  ) {}

  @Post('proposals')
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateReadingGroupProposalDto,
  ) {
    return this.readingGroupProposalsService.create(user.userId, dto);
  }
}
