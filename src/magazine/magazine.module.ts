import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminMembersModule } from '../admin-members/admin-members.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MailerModule } from '../mailer/mailer.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { NewsletterSubscription } from '../newsletter/entities/newsletter-subscription.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminMagazineDecksController } from './admin-magazine-decks.controller';
import { AdminMagazineIssuesController } from './admin-magazine-issues.controller';
import { AdminMagazinePiecesController } from './admin-magazine-pieces.controller';
import { AdminStorySubmissionsController } from './admin-story-submissions.controller';
import { AdminStorySubmissionsService } from './admin-story-submissions.service';
import { AdminWriterApplicationsController } from './admin-writer-applications.controller';
import { AdminWriterApplicationsService } from './admin-writer-applications.service';
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
import { MagazineReaderComment } from './entities/magazine-reader-comment.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import { MagazineStorySubmission } from './entities/magazine-story-submission.entity';
import { MagazineWriterApplication } from './entities/magazine-writer-application.entity';
import { MagazineController } from './magazine.controller';
import { MagazinePieceService } from './magazine-piece.service';
import { MagazineReaderCommentsService } from './magazine-reader-comments.service';
import { MagazineWriterController } from './magazine-writer.controller';
import { MagazineService } from './magazine.service';
import { StorySubmissionsService } from './story-submissions.service';
import { WriterApplicationsController } from './writer-applications.controller';
import { WriterApplicationsService } from './writer-applications.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MagazineArticle,
      MagazineArticleComment,
      MagazineArticleVersion,
      MagazineAuthor,
      MagazineCorrection,
      MagazineDeck,
      MagazineIssue,
      MagazineLetter,
      MagazinePayment,
      MagazinePiece,
      MagazinePieceEvent,
      MagazinePieceMessage,
      MagazinePitch,
      MagazineReaderComment,
      MagazineSection,
      MagazineStorySubmission,
      MagazineWriterApplication,
      NewsletterSubscription,
      Profile,
      User,
      UserStaffRole,
    ]),
    NotificationsModule,
    MediaCropsModule,
    MailerModule,
    ContentModerationModule,
    // `AdminMembersService.grantStaffRole` — writer-application approval
    // grants `magazine_writer` through the same mechanism the manual admin
    // role-assignment screen uses (see `AdminWriterApplicationsService`).
    AdminMembersModule,
  ],
  controllers: [
    MagazineController,
    AdminMagazineDecksController,
    AdminMagazineIssuesController,
    AdminMagazinePiecesController,
    AdminStorySubmissionsController,
    MagazineWriterController,
    WriterApplicationsController,
    AdminWriterApplicationsController,
  ],
  providers: [
    MagazineService,
    StorySubmissionsService,
    AdminStorySubmissionsService,
    MagazinePieceService,
    MagazineReaderCommentsService,
    WriterApplicationsService,
    AdminWriterApplicationsService,
  ],
  exports: [StorySubmissionsService, MagazineService],
})
export class MagazineModule {}
