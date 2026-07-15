import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazineStorySubmission } from './entities/magazine-story-submission.entity';
import { MagazineController } from './magazine.controller';
import { MagazineService } from './magazine.service';
import { StorySubmissionsService } from './story-submissions.service';

// NOT wired into app.module.ts by this task (coordination protocol: the
// orchestrator registers modules centrally after a tier's agents finish).
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MagazineArticle,
      MagazineAuthor,
      MagazineIssue,
      MagazineStorySubmission,
    ]),
  ],
  controllers: [MagazineController],
  providers: [MagazineService, StorySubmissionsService],
  exports: [MagazineService, StorySubmissionsService],
})
export class MagazineModule {}
