import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminMagazineDecksController } from './admin-magazine-decks.controller';
import { AdminMagazineIssuesController } from './admin-magazine-issues.controller';
import { AdminMagazinePiecesController } from './admin-magazine-pieces.controller';
import { AdminStorySubmissionsController } from './admin-story-submissions.controller';
import { AdminStorySubmissionsService } from './admin-story-submissions.service';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineArticleComment } from './entities/magazine-article-comment.entity';
import { MagazineArticleVersion } from './entities/magazine-article-version.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import { MagazineStorySubmission } from './entities/magazine-story-submission.entity';
import { MagazineController } from './magazine.controller';
import { MagazinePieceService } from './magazine-piece.service';
import { MagazineWriterController } from './magazine-writer.controller';
import { MagazineService } from './magazine.service';
import { StorySubmissionsService } from './story-submissions.service';

// NOT wired into app.module.ts by this task (coordination protocol: the
// orchestrator registers modules centrally after a tier's agents finish).
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MagazineArticle,
      // Task D1 (article comments/NotesRail) — no FK relation, plain
      // indexed uuid columns, same idiom as every other magazine_* table.
      MagazineArticleComment,
      // Task E1 (article versions/VersionsRail) — same idiom: plain indexed
      // uuid columns, no FK relation.
      MagazineArticleVersion,
      MagazineAuthor,
      MagazineCorrection,
      MagazineDeck,
      MagazineIssue,
      MagazineLetter,
      MagazinePayment,
      MagazinePiece,
      MagazinePieceEvent,
      // Task F1 (editor↔writer message thread) — same idiom: plain indexed
      // uuid columns, no FK relation.
      MagazinePieceMessage,
      MagazinePitch,
      MagazineSection,
      MagazineStorySubmission,
      // Registered here (overlapping `forFeature` is permitted) so the admin
      // submission read model can resolve submitter refs, and so
      // `MagazinePieceService.listMagazineEditors` (Magazine Desk Phase 7,
      // Task A1) can resolve editor names/avatars.
      Profile,
      // `MagazinePieceService.listMagazineEditors` (Task A1) reads the
      // admin superset off this repo.
      User,
      // StaffRolesGuard (AdminMagazineDecksController, AdminMagazinePiecesController) injects this repo;
      // also read directly by `listMagazineEditors` (Task A1).
      UserStaffRole,
    ]),
    // `NotificationsService` — Task F1 posts a notification to the OTHER
    // party (editor → writer, or writer → editor) whenever a piece message
    // is posted.
    NotificationsModule,
  ],
  controllers: [
    MagazineController,
    AdminMagazineDecksController,
    AdminMagazineIssuesController,
    AdminMagazinePiecesController,
    AdminStorySubmissionsController,
    MagazineWriterController,
  ],
  providers: [
    MagazineService,
    StorySubmissionsService,
    AdminStorySubmissionsService,
    MagazinePieceService,
  ],
  // MagazineService is exported for the cross-entity SearchModule (magazine
  // article search); StorySubmissionsService for the story-submission flow.
  exports: [StorySubmissionsService, MagazineService],
})
export class MagazineModule {}
