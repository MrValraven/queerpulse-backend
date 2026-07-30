import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReadingGroupProposal } from './entities/reading-group-proposal.entity';
import { ReadingGroupProposalsController } from './reading-group-proposals.controller';
import { ReadingGroupProposalsService } from './reading-group-proposals.service';

@Module({
  imports: [TypeOrmModule.forFeature([ReadingGroupProposal])],
  controllers: [ReadingGroupProposalsController],
  providers: [ReadingGroupProposalsService],
})
export class ReadingGroupProposalsModule {}
