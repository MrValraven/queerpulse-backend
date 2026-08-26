import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { GetGovernanceFinancesQuery } from './dto/get-governance-finances.query';
import { CreateGovernanceMotionDto } from './dto/create-governance-motion.dto';
import { CreateGovernanceProposalDto } from './dto/create-governance-proposal.dto';
import { CastGovernanceVoteDto } from './dto/cast-governance-vote.dto';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceProposalService } from './governance-proposal.service';
import { GovernanceProposalDTO } from './governance-proposal-response';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/** The platform roles that receive a "this motion is ready for screening"
 *  alert. Mirrors `CommunityOwnerReviewService`'s `PLATFORM_STAFF_ROLES`
 *  (moderators and admins). */
const PLATFORM_STAFF_ROLES = [UserRole.Moderator, UserRole.Admin];

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
  private readonly logger = new Logger(GovernanceController.name);

  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
    private readonly governanceOverviewService: GovernanceOverviewService,
    private readonly governanceProposalService: GovernanceProposalService,
    private readonly notifications: NotificationsService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
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

  // ── Member motions (GOV-01) ──────────────────────────────────────────────
  // Until these routes existed, only an admin could put anything to the
  // community: `POST /governance/proposals` above is admin-gated, so the
  // public Governance page promised members a vote on decisions members had
  // no way to raise. A motion closes that loop from the other end.
  //
  // A member files the QUESTION and nothing more. The motion then has to earn
  // its way onto a ballot: ten members must put their names to it (the
  // proposer counts as the first), which moves it to `screening`, and only
  // then does an admin decide whether it goes to a vote and in what window.
  // The threshold is the point — it keeps the ballot from filling with motions
  // one person cared about, without letting staff quietly bin a motion the
  // community clearly wanted (a refusal is a recorded, reasoned act that the
  // proposer is told about).
  //
  // A co-signature is NOT a vote: it says "put this to the community", and a
  // co-signer is free to vote it down once it is on the ballot. That is why
  // withdrawing one is a plain DELETE with no ceremony around it.
  //
  // All three writes carry `NotRestrictedGuard` for the same reason `castVote`
  // does: a member under an active moderation restriction stays `active`, so
  // the class-level `ActiveMemberGuard` alone would let them file and sign.

  @Post('motions')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'File a member motion and start its co-signature drive',
  })
  @ApiCreatedResponse({
    description:
      'The filed motion at `gathering`, already carrying the proposer’s ' +
      'own founding co-signature.',
  })
  @ApiForbiddenResponse({
    description: 'A moderation restriction is in effect for the caller.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'The caller has already filed a motion inside the per-member filing ' +
      'window.',
  })
  createMotion(
    @Body() dto: CreateGovernanceMotionDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceProposalService.createMotion(dto, user.userId);
  }

  @Post('proposals/:id/cosign')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Co-sign a member motion so it reaches staff screening',
  })
  @ApiCreatedResponse({
    description: 'The motion with its updated co-signature count.',
  })
  @ApiForbiddenResponse({
    description:
      'A moderation restriction is in effect for the caller, or the ' +
      'co-signature drive is no longer open.',
  })
  @ApiNotFoundResponse({ description: 'No motion with that id.' })
  async cosignMotion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<GovernanceProposalDTO> {
    const result = await this.governanceProposalService.cosign(id, user.userId);
    // The signature that tips a motion over its threshold is the ONLY moment
    // anything moves it to `screening`, so the staff alert fires here, after
    // that write has committed, and never on the signatures before it.
    if (result.hasReachedThreshold) {
      await this.notifyPlatformStaffOfMotion(result.proposal);
    }
    return result.proposal;
  }

  @Delete('proposals/:id/cosign')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw the caller’s co-signature from a motion' })
  @ApiOkResponse({
    description: 'The motion with its updated co-signature count.',
  })
  @ApiForbiddenResponse({
    description:
      'A moderation restriction is in effect for the caller, the caller is ' +
      'the proposer (whose founding signature cannot be withdrawn), or the ' +
      'drive has already closed.',
  })
  @ApiNotFoundResponse({ description: 'No motion with that id.' })
  withdrawCosignature(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceProposalService.withdrawCosignature(id, user.userId);
  }

  /**
   * Tells platform staff a motion has cleared its co-signature threshold and
   * is waiting on a screening decision.
   *
   * Best-effort by construction, following `CommunityOwnerReviewService`'s
   * `notifyPlatformStaff` contract: it runs AFTER the co-signature write has
   * committed and its own try/catch swallows every failure into a log line. A
   * bell that could not be written must never turn a member's successful
   * co-signature into a 500.
   *
   * `createForRecipients` is deliberately called WITHOUT an `actorId`. That
   * argument applies each recipient's block/mute list, which is right for
   * member-driven notifications and wrong here: this is a duty alert, and a
   * motion ten members are behind must not go unscreened because the
   * moderator on shift once muted whoever happened to cast the tenth
   * signature.
   */
  private async notifyPlatformStaffOfMotion(
    proposal: GovernanceProposalDTO,
  ): Promise<void> {
    try {
      const staff = await this.users.find({
        where: {
          role: In(PLATFORM_STAFF_ROLES),
          status: UserStatus.Active,
        },
        select: { id: true },
      });
      const recipientIds = staff.map((staffUser) => staffUser.id);
      if (!recipientIds.length) return;

      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.GovernanceMotionReadyForReview,
        {
          source: 'governance',
          proposalId: proposal.id,
          title: proposal.title,
          cosignatureCount: proposal.cosignatureCount,
        },
      );
    } catch (error) {
      this.logger.error(
        `Motion ${proposal.id} reached its co-signature threshold, but notifying platform staff failed: ${String(error)}`,
      );
    }
  }
}
