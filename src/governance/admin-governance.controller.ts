import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { ApproveGovernanceMotionDto } from './dto/approve-governance-motion.dto';
import { ListFinanceChangesQuery } from './dto/list-finance-changes.query';
import { ListGovernanceMotionsQuery } from './dto/list-governance-motions.query';
import { RejectGovernanceMotionDto } from './dto/reject-governance-motion.dto';
import { ListOverviewChangesQuery } from './dto/list-overview-changes.query';
import { UpdateAdminFinancesDto } from './dto/update-admin-finances.dto';
import { UpdateAdminOverviewDto } from './dto/update-admin-overview.dto';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceProposalService } from './governance-proposal.service';
import { GovernanceProposalDTO } from './governance-proposal-response';

const DEFAULT_FINANCE_CHANGES_LIMIT = 50;
const DEFAULT_OVERVIEW_CHANGES_LIMIT = 50;

/**
 * Staff surface behind `/admin/governance` (the Finances and Policy tabs).
 *
 * These handlers used to live on `GovernanceController` under a `admin/*`
 * path prefix, each repeating its own method-level `@UseGuards(RolesGuard)`
 * on top of a member-facing class — one forgotten decorator would have
 * exposed an admin route to every active member (BE-COM-14). They now sit on
 * a dedicated `Admin*Controller` with class-level default-deny
 * (`ActiveMemberGuard` + `RolesGuard` + `@Roles`), matching every other admin
 * surface in the repo (`AdminForumController`,
 * `AdminReadingGroupProposalsController`).
 *
 * The class default is Moderator-or-Admin (read access). The two writes
 * narrow to Admin with a method-level `@Roles`, which `RolesGuard` honours via
 * `Reflector.getAllAndOverride` — a *narrowing* override, so a missing one
 * fails closed at Moderator rather than opening the route up.
 *
 * The member-facing reads (`GET /governance/overview`, `/governance/finances`)
 * and the proposal/vote routes stay on `GovernanceController`.
 */
@Feature('governance')
@ApiTags('Admin — Governance')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
@Controller('admin/governance')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin, UserRole.Moderator)
export class AdminGovernanceController {
  private readonly logger = new Logger(AdminGovernanceController.name);

  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
    private readonly governanceOverviewService: GovernanceOverviewService,
    private readonly governanceProposalService: GovernanceProposalService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('finances')
  @ApiOperation({
    summary: 'Get the admin Finances tab data (latest quarter + history)',
  })
  @ApiOkResponse({
    description: 'Latest quarter metrics plus the historical series.',
  })
  getAdminFinances() {
    return this.governanceFinanceService.getAdminFinances();
  }

  // Admin-only (NOT moderators, unlike the GET above): correcting the
  // published finance figures is a higher-blast-radius action, mirroring the
  // admin-only-write stance of `PlatformSettingsController`. State-changing,
  // so it carries a CSRF token behind the global guard chain.
  @Patch('finances')
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Correct editable figures on the latest report' })
  @ApiOkResponse({
    description: 'The updated Finances tab payload (latest + history).',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No finance report exists to edit.' })
  updateAdminFinances(
    @Body() dto: UpdateAdminFinancesDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceFinanceService.updateAdminFinances(dto, user.userId);
  }

  // Admin-only: the per-field audit trail behind the "last edited" badges.
  @Get('finances/changes')
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'List the finance figure change history' })
  @ApiOkResponse({ description: 'The audit history, newest first.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  listFinanceChanges(@Query() query: ListFinanceChangesQuery) {
    return this.governanceFinanceService.listChanges(
      query.limit ?? DEFAULT_FINANCE_CHANGES_LIMIT,
      query.offset ?? 0,
    );
  }

  // Stamps `governance_overview.published_at = now()` so the public overview
  // can show a "last published" line. State-changing, so it carries a CSRF
  // token like every other POST behind the global guard chain.
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish the current governance overview snapshot' })
  @ApiOkResponse({
    description: 'The timestamp the snapshot was published at.',
  })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  publish() {
    return this.governanceOverviewService.publish();
  }

  @Get('overview')
  @ApiOperation({
    summary:
      'Get the admin Policy tab data (overview + per-section audit meta)',
  })
  @ApiOkResponse({
    description: 'The overview sections plus per-section last-edited info.',
  })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  getAdminOverview() {
    return this.governanceOverviewService.getAdminOverview();
  }

  // Admin-only (NOT moderators): replacing overview sections is a
  // higher-blast-radius action, mirroring `updateAdminFinances` above.
  @Patch('overview')
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Replace any subset of the overview sections' })
  @ApiOkResponse({
    description: 'The updated Policy tab payload (overview + audit meta).',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  updateAdminOverview(
    @Body() dto: UpdateAdminOverviewDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceOverviewService.updateOverview(dto, user.userId);
  }

  // Admin-only: the per-section audit trail behind the "last edited" badges.
  @Get('overview/changes')
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'List the overview section change history' })
  @ApiOkResponse({ description: 'The audit history, newest first.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  listOverviewChanges(@Query() query: ListOverviewChangesQuery) {
    return this.governanceOverviewService.listChanges(
      query.limit ?? DEFAULT_OVERVIEW_CHANGES_LIMIT,
      query.offset ?? 0,
    );
  }

  // ── Member motions (GOV-01) ──────────────────────────────────────────────
  // The staff end of the loop `GovernanceController`'s member routes open.
  // A member files a motion, the community co-signs it past its threshold,
  // and it lands here at `screening` waiting on the one decision only staff
  // can make: does this go to a community vote, and in what window.
  //
  // The read is Moderator-or-Admin (the class default) because watching the
  // queue is part of moderating. Both writes narrow to Admin with a
  // method-level `@Roles`, matching the finance and overview writes above:
  // putting a question to the whole community, or refusing to, is the
  // higher-blast-radius half of this surface.

  @Get('motions')
  @ApiOperation({
    summary: 'List member motions, defaulting to the screening queue',
  })
  @ApiOkResponse({
    description:
      'Motions newest-first. Omitting `status` returns the `screening` ' +
      'queue; pass one to inspect any other shelf.',
  })
  listMotions(
    @Query() query: ListGovernanceMotionsQuery,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceProposalService.listMotions(
      query.status,
      user.userId,
    );
  }

  // Admin-only (NOT moderators, like every other write on this controller):
  // approving a motion opens a real community ballot.
  @Post('motions/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.Admin)
  @ApiOperation({
    summary: 'Put a screened motion to the community with a voting window',
  })
  @ApiOkResponse({
    description: 'The motion, now an `open` ballot with its granted window.',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  async approveMotion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveGovernanceMotionDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<GovernanceProposalDTO> {
    const proposal = await this.governanceProposalService.approveMotion(
      id,
      dto,
      user.userId,
    );
    await this.notifyProposerOfDecision(
      proposal,
      NotificationType.GovernanceMotionApproved,
      {
        opensAt: proposal.opensAt,
        closesAt: proposal.closesAt,
      },
    );
    return proposal;
  }

  // Admin-only, same reasoning as the approval: declining a motion ten
  // members put their names to is a recorded, reasoned act, and the DTO makes
  // the note mandatory so the proposer always learns why.
  @Post('motions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Decline to put a motion to the community' })
  @ApiOkResponse({
    description: 'The motion at `rejected`, carrying the recorded reason.',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No proposal with that id.' })
  async rejectMotion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectGovernanceMotionDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<GovernanceProposalDTO> {
    const proposal = await this.governanceProposalService.rejectMotion(
      id,
      dto,
      user.userId,
    );
    // The reason travels in the payload so the bell itself can carry it: a
    // member who is told "declined" and has to go hunting for why is the
    // opaque decision this module exists to rule out.
    await this.notifyProposerOfDecision(
      proposal,
      NotificationType.GovernanceMotionRejected,
      { note: dto.note },
    );
    return proposal;
  }

  /**
   * Tells the member who filed a motion what staff decided about it.
   *
   * Best-effort by construction, the same contract
   * `GovernanceController.notifyPlatformStaffOfMotion` follows: it runs AFTER
   * the screening write has committed and its own try/catch swallows every
   * failure into a log line. A bell that could not be written must never turn
   * a committed admin decision into a 500 the admin would then retry against
   * a motion that has already moved.
   *
   * Skipped entirely when `proposedByMemberId` is null. That is either an
   * admin-opened proposal, which has no proposer at all, or a motion whose
   * filer erased their account (the FK is `ON DELETE SET NULL`) — there is
   * nobody left to tell.
   *
   * `create` is called WITHOUT an `actorId` on purpose. That argument applies
   * the recipient's own block/mute list, which is right for member-driven
   * notifications and wrong here: this is the outcome of the member's own
   * motion, and it must not go undelivered because they had once muted
   * whichever admin happened to pick the decision up.
   */
  private async notifyProposerOfDecision(
    proposal: GovernanceProposalDTO,
    type: NotificationType,
    extraPayload: Record<string, unknown>,
  ): Promise<void> {
    const proposerId = proposal.proposedByMemberId;
    if (!proposerId) return;

    try {
      await this.notifications.create(proposerId, type, {
        source: 'governance',
        proposalId: proposal.id,
        title: proposal.title,
        ...extraPayload,
      });
    } catch (error) {
      this.logger.error(
        `Motion ${proposal.id} was screened, but notifying its proposer failed: ${String(error)}`,
      );
    }
  }
}
