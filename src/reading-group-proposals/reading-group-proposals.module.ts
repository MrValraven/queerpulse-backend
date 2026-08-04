import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
  imports: [TypeOrmModule.forFeature([ReadingGroupProposal, Profile])],
  controllers: [
    ReadingGroupProposalsController,
    AdminReadingGroupProposalsController,
  ],
  providers: [ReadingGroupProposalsService, AdminReadingGroupProposalsService],
})
export class ReadingGroupProposalsModule {}
