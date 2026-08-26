import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { AdminGovernanceController } from './admin-governance.controller';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceProposalService } from './governance-proposal.service';
import { GovernanceFinanceChange } from './entities/governance-finance-change.entity';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';
import { GovernanceOverview } from './entities/governance-overview.entity';
import { GovernanceOverviewChange } from './entities/governance-overview-change.entity';
import { GovernanceProposal } from './entities/governance-proposal.entity';
import { GovernanceProposalCosignature } from './entities/governance-proposal-cosignature.entity';
import { GovernanceVote } from './entities/governance-vote.entity';
import { GovernanceMotionSweeperService } from './governance-motion-sweeper.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
// `NotificationsService` — the member-motion bells (GOV-01): staff hear that a
// motion cleared its co-signature threshold, and the proposer hears what staff
// decided. Plain import rather than `forwardRef`: `NotificationsModule` pulls
// in `SocialModule` and `CommunityMembershipModule`, neither of which reaches
// back to `GovernanceModule`, so there is no cycle to break.
import { NotificationsModule } from '../notifications/notifications.module';
// `UsersModule` exports `UsersService`, whose `countActiveMembers()` backs
// the live "active members" health stat (COM-4) — same injected-service
// pattern `AdminOverviewModule` uses, rather than this module re-registering
// `User` via its own `TypeOrmModule.forFeature` and duplicating the query.
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernanceFinanceReport,
      GovernanceFinanceChange,
      GovernanceOverview,
      GovernanceOverviewChange,
      GovernanceProposal,
      GovernanceProposalCosignature,
      GovernanceVote,
      Profile,
      // `User` — `GovernanceController` injects this repository directly for
      // the motion-ready-for-screening staff fan-out, which needs the platform's
      // active `Moderator`/`Admin` accounts by role. `UsersModule` below exports
      // `UsersService`, which has no such role query, and TypeORM permits one
      // entity's repository in more than one module.
      User,
    ]),
    UsersModule,
    NotificationsModule,
  ],
  // `AdminGovernanceController` (`/admin/governance/*`) carries the staff
  // routes that used to live on `GovernanceController` under an `admin/*`
  // path prefix — see BE-COM-14. It reuses this module's services, so it is
  // registered here rather than in a separate top-level module.
  controllers: [GovernanceController, AdminGovernanceController],
  providers: [
    GovernanceFinanceService,
    GovernanceOverviewService,
    GovernanceProposalService,
    // GOV-01: daily `@Cron` that flips member motions whose co-signature
    // window ran out to `lapsed`. Failing to reach the threshold is the
    // absence of an event, so nothing in the request path can notice it.
    // Registered as a plain provider: `ScheduleModule.forRoot()` is already
    // registered once app-wide in `AppModule` and must not be imported here
    // (same precedent as `CommunityActivityCounterService` and
    // `HousingListingExpirySweeperService`).
    GovernanceMotionSweeperService,
  ],
  // `GovernanceFinanceService` is reused directly by `AdminReportsModule`
  // (the consolidated `/admin/reports` page's finance section) so that page
  // can never drift from the governance Finances tab's own figures.
  exports: [GovernanceFinanceService],
})
export class GovernanceModule {}
