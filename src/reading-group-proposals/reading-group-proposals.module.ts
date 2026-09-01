import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { CommunitiesModule } from '../communities/communities.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { AdminReadingGroupProposalsController } from './admin-reading-group-proposals.controller';
import { AdminReadingGroupProposalsService } from './admin-reading-group-proposals.service';
import { ReadingGroupProposal } from './entities/reading-group-proposal.entity';
import { ReadingGroupProposalsController } from './reading-group-proposals.controller';
import { ReadingGroupProposalsService } from './reading-group-proposals.service';

@Module({
  // `Profile` is registered here (overlapping `forFeature` is permitted) so the
  // admin read model can resolve proposer refs — same pattern as
  // `AdminInvitesModule`.
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,
      ReadingGroupProposal,
      Profile,
    ]),
    // `CommunitiesService.create` — approving a proposal builds the real
    // community the member asked for, owned by them (LOC-19), reusing that
    // service rather than reimplementing slug allocation, the ref sequence and
    // the owner's roster row. No cycle: `CommunitiesModule` does not import
    // this module, directly or transitively.
    CommunitiesModule,
    // `NotificationsService` — the proposer is told the outcome of their own
    // submission, in-app and on their phone. Same no-cycle argument.
    NotificationsModule,
    // `AdminQueueNotificationsService`: tells the reading-group-proposal
    // queue's reviewers when a member submits a new proposal.
    AdminQueueNotificationsModule,
  ],
  controllers: [
    ReadingGroupProposalsController,
    AdminReadingGroupProposalsController,
  ],
  providers: [ReadingGroupProposalsService, AdminReadingGroupProposalsService],
})
export class ReadingGroupProposalsModule {}
