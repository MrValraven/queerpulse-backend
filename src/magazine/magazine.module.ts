import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminMembersModule } from '../admin-members/admin-members.module';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { SocialModule } from '../social/social.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminMagazineAuthorsController } from './admin-magazine-authors.controller';
import { AdminMagazineDecksController } from './admin-magazine-decks.controller';
import { AdminMagazineDeskViewsController } from './admin-magazine-desk-views.controller';
import { AdminMagazineIssuesController } from './admin-magazine-issues.controller';
import { AdminMagazineLifecycleController } from './admin-magazine-lifecycle.controller';
import { AdminMagazinePiecesController } from './admin-magazine-pieces.controller';
import { AdminMagazineWritersController } from './admin-magazine-writers.controller';
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
import { MagazineDeskView } from './entities/magazine-desk-view.entity';
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
import { MagazineFrontController } from './magazine-front.controller';
import { MagazineFrontService } from './magazine-front.service';
import { MagazineIssueContentsController } from './magazine-issue-contents.controller';
import { MagazineIssueContentsService } from './magazine-issue-contents.service';
import { MagazineIssueAnnouncerService } from './magazine-issue-announcer.service';
import { MagazineIssueCostsService } from './magazine-issue-costs.service';
import { MagazineDeskPresenceGateway } from './magazine-desk-presence.gateway';
import { MagazineDeskPresenceService } from './magazine-desk-presence.service';
import { MagazineDeskViewsService } from './magazine-desk-views.service';
import { MagazineLifecycleService } from './magazine-lifecycle.service';
import { MagazinePieceService } from './magazine-piece.service';
import { MagazineReaderCommentsService } from './magazine-reader-comments.service';
import { MagazineWriterController } from './magazine-writer.controller';
import { MagazineWriterDirectoryService } from './magazine-writer-directory.service';
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
      MagazineDeskView,
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
      Profile,
      User,
      UserStaffRole,
      // Read-side only: the desk presence handshake asks whether the session
      // behind the access token is still live, as `ChatGateway` does.
      RefreshToken,
    ]),
    // The desk presence gateway verifies the handshake token itself and
    // passes the secret on each call, as `ChatGateway` does, so no defaults.
    JwtModule.register({}),
    // `PlatformSettingsService`: the desk presence handshake applies the
    // platform-lockdown rule, as `ChatGateway` does. That module imports only
    // `TypeOrmModule`, so this adds no cycle.
    PlatformSettingsModule,
    NotificationsModule,
    MediaCropsModule,
    ContentModerationModule,
    // ENG-101 — reader comments were the one launched surface applying
    // neither the block nor the mute filter, so a blocked pair met under a
    // public article. `MagazineReaderCommentsService` now injects
    // `BlockFilterService` for both the comment and reply queries and for the
    // reply gate. Plain import, no `forwardRef`: `SocialModule` imports only
    // `TypeOrmModule`, `UsersModule` and `ReportsModule`, none of which
    // reaches `MagazineModule`.
    SocialModule,
    // `NotificationsService` is already imported above for the piece/issue
    // bells; `AdminStorySubmissionsService` uses the same provider to tell a
    // submitter their story was accepted, declined, or commissioned.
    // `AdminMembersService.grantStaffRole` — writer-application approval
    // grants `magazine_writer` through the same mechanism the manual admin
    // role-assignment screen uses (see `AdminWriterApplicationsService`).
    AdminMembersModule,
    // Tells whoever works the magazine-submission and writer-application
    // queues when a member's own story or application lands.
    AdminQueueNotificationsModule,
  ],
  controllers: [
    MagazineController,
    MagazineFrontController,
    MagazineIssueContentsController,
    AdminMagazineAuthorsController,
    AdminMagazineDecksController,
    // Each editor's saved desk views. Its own controller, per the admin-CRUD
    // convention.
    AdminMagazineDeskViewsController,
    AdminMagazineIssuesController,
    // CON-16 — the content lifecycle desk (archive, supersede, re-review,
    // translations). Its own controller, per the admin-CRUD convention.
    AdminMagazineLifecycleController,
    AdminMagazinePiecesController,
    // The desk's writer picker (`GET magazine/admin/writers`).
    AdminMagazineWritersController,
    AdminStorySubmissionsController,
    MagazineWriterController,
    WriterApplicationsController,
    AdminWriterApplicationsController,
  ],
  providers: [
    MagazineService,
    MagazineFrontService,
    MagazineIssueContentsService,
    MagazineIssueCostsService,
    // The member-wide bell for a shipped issue, called by `shipIssue`.
    MagazineIssueAnnouncerService,
    MagazineWriterDirectoryService,
    MagazineDeskViewsService,
    MagazineLifecycleService,
    StorySubmissionsService,
    AdminStorySubmissionsService,
    MagazinePieceService,
    MagazineReaderCommentsService,
    WriterApplicationsService,
    AdminWriterApplicationsService,
    // Who is viewing which piece on the desk (namespace `/magazine-desk`).
    MagazineDeskPresenceService,
    MagazineDeskPresenceGateway,
  ],
  exports: [StorySubmissionsService, MagazineService],
})
export class MagazineModule {}
