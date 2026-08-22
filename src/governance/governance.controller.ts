import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { GetGovernanceFinancesQuery } from './dto/get-governance-finances.query';
import { CreateGovernanceProposalDto } from './dto/create-governance-proposal.dto';
import { CastGovernanceVoteDto } from './dto/cast-governance-vote.dto';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceProposalService } from './governance-proposal.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Read-only controller serving the structured data behind `/about/governance`.
// Both endpoints follow the "structure in the DB, words in i18n" model: they
// return content keys, numbers, and non-translatable data (names/initials),
// and the frontend resolves the translated prose from its i18n catalogs.
//   • `GET /governance/overview` — the non-financial page structure (health
//     snapshot, moderation steps, advisory council, principles, decision log).
//   • `GET /governance/finances` — the quarterly financial-transparency
//     snapshot (stats/income/expense/eventNotes) plus the reserve + partner
//     disclosures rendered alongside it.

@Feature('governance')
@ApiTags('Governance')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('governance')
@UseGuards(ActiveMemberGuard)
export class GovernanceController {
  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
    private readonly governanceOverviewService: GovernanceOverviewService,
    private readonly governanceProposalService: GovernanceProposalService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get the non-financial governance page structure' })
  @ApiOkResponse({ description: 'The governance overview snapshot.' })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  getOverview() {
    return this.governanceOverviewService.getOverview();
  }

  @Get('finances')
  @ApiOperation({
    summary: 'Get the quarterly financial-transparency snapshot',
  })
  @ApiOkResponse({ description: 'The finance report for the quarter.' })
  @ApiNotFoundResponse({
    description: 'No finance report exists for the requested quarter.',
  })
  getFinances(@Query() query: GetGovernanceFinancesQuery) {
    return this.governanceFinanceService.getFinances(query.quarter);
  }

  // ── Proposals & votes (COM-1) ────────────────────────────────────────────
  // Backs the "two-thirds community vote" (council removal) and "the
  // community will vote on it" (funding-policy change) promises made on the
  // public Governance page — real member votes, tallied live from
  // `governance_votes`, modeled on `RoadmapController`'s vote routes.

  @Post('proposals')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Open a new governance proposal for a member vote' })
  @ApiCreatedResponse({ description: 'The created proposal.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  createProposal(
    @Body() dto: CreateGovernanceProposalDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceProposalService.createProposal(dto, user.userId);
  }

  @Get('proposals')
  @ApiOperation({
    summary: 'List every governance proposal, open and resolved',
  })
  @ApiOkResponse({
    description: 'Proposals newest-first, each with a live tally.',
  })
  listProposals(@CurrentUser() user: CurrentUserData) {
    return this.governanceProposalService.listProposals(user.userId);
  }

  @Get('proposals/:id')
  @ApiOperation({ summary: 'Get one governance proposal with its live tally' })
  @ApiOkResponse({
    description: 'The proposal, its tally, and the caller’s own vote.',
  })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  getProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceProposalService.getProposal(id, user.userId);
  }

  // Voting is a governance write, so a member under an active moderation
  // restriction (`ModActionCode.restrict`) must not cast or re-cast a vote —
  // mirrors the method-level `NotRestrictedGuard` other member-facing writes use
  // (e.g. messaging `send`). A restriction keeps the member `active` (so the
  // class-level `ActiveMemberGuard` alone would let them through), which is
  // exactly why this narrower guard is layered on top here.
  @Post('proposals/:id/vote')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Cast a for/against vote, or change it while voting is still open',
  })
  @ApiCreatedResponse({
    description: 'The proposal, its updated tally, and the caller’s vote.',
  })
  @ApiForbiddenResponse({
    description:
      'A moderation restriction is in effect for the caller, or the proposal ' +
      'is about the caller (nobody votes on a proposal about themselves).',
  })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  castVote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CastGovernanceVoteDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceProposalService.castVote(user.userId, id, dto);
  }
}
