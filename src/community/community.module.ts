import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChangemakerNominationsController } from './changemaker-nominations.controller';
import { ChangemakerNominationsService } from './changemaker-nominations.service';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';
import { ReadingGroupProposal } from './entities/reading-group-proposal.entity';
import { ReadingGroupProposalsController } from './reading-group-proposals.controller';
import { ReadingGroupProposalsService } from './reading-group-proposals.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReadingGroupProposal, ChangemakerNomination]),
  ],
  controllers: [
    ReadingGroupProposalsController,
    ChangemakerNominationsController,
  ],
  providers: [ReadingGroupProposalsService, ChangemakerNominationsService],
})
export class CommunityModule {}
