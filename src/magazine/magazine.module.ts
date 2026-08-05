import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminMagazineDecksController } from './admin-magazine-decks.controller';
import { AdminStorySubmissionsController } from './admin-story-submissions.controller';
import { AdminStorySubmissionsService } from './admin-story-submissions.service';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
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
      MagazineDeck,
      MagazineIssue,
      MagazineStorySubmission,
      // Registered here (overlapping `forFeature` is permitted) so the admin
      // submission read model can resolve submitter refs.
      Profile,
      // StaffRolesGuard (AdminMagazineDecksController) injects this repo.
      UserStaffRole,
    ]),
  ],
  controllers: [
    MagazineController,
    AdminMagazineDecksController,
    AdminStorySubmissionsController,
  ],
  providers: [
    MagazineService,
    StorySubmissionsService,
    AdminStorySubmissionsService,
  ],
  // MagazineService is exported for the cross-entity SearchModule (magazine
  // article search); StorySubmissionsService for the story-submission flow.
  exports: [StorySubmissionsService, MagazineService],
})
export class MagazineModule {}
