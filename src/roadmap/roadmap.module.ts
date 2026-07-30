import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapIdea } from './entities/roadmap-idea.entity';
import { RoadmapVote } from './entities/roadmap-vote.entity';
import { RoadmapSettings } from './entities/roadmap-settings.entity';
import { RoadmapService } from './roadmap.service';
import { RoadmapAdminService } from './roadmap-admin.service';
import { RoadmapController } from './roadmap.controller';
import { RoadmapPublicController } from './roadmap-public.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoadmapItem,
      RoadmapIdea,
      RoadmapVote,
      RoadmapSettings,
    ]),
  ],
  controllers: [RoadmapPublicController, RoadmapController],
  providers: [RoadmapService, RoadmapAdminService],
})
export class RoadmapModule {}
