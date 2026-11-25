import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModerationModule } from '../moderation/moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecognitionAward } from '../recognition/entities/recognition-award.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminQuizBadgesController } from './admin-quiz-badges.controller';
import { AdminQuizEventBadgesController } from './admin-quiz-event-badges.controller';
import { QuizBadgeDefinition } from './entities/quiz-badge-definition.entity';
import { QuizBadgeWin } from './entities/quiz-badge-win.entity';
import { QuizEventBadgeSlot } from './entities/quiz-event-badge-slot.entity';
import { QuizGameWinner } from './entities/quiz-game-winner.entity';
import { QuizBadgeAwardingService } from './quiz-badge-awarding.service';
import { QuizBadgeLibraryService } from './quiz-badge-library.service';
import { QuizEventBadgesService } from './quiz-event-badges.service';
import { QuizGameWinnersListener } from './quiz-game-winners.listener';

/**
 * Quiz win badges: the staff badge library, the per event badge setup, the
 * winner recording at game end and the awarding of the badges.
 *
 * This module imports neither `QuizshowModule` nor `RecognitionModule`, and
 * neither imports it, so the graph has no cycle and needs no `forwardRef`.
 * Pulse Live reaches it through the `QUIZ_EVENT_GAME_FINISHED` event that
 * `QuizGameWinnersListener` handles, and Pulse Live, the event detail and
 * recognition read its tables through pure helpers and raw SQL. The event
 * emitter is registered once in `AppModule`, so the `@OnEvent` provider below
 * only needs to be listed here.
 *
 * Every injected dependency and where it comes from:
 * - `DataSource`: the global TypeORM root connection.
 * - The `QuizBadgeDefinition`, `QuizEventBadgeSlot`, `QuizGameWinner`,
 *   `QuizBadgeWin`, `RecognitionAward` and `Profile` repositories: the
 *   `forFeature` registration below.
 * - `NotificationsService`: `NotificationsModule`.
 * - `ModAuditService`: `ModerationModule`.
 * - `QuizBadgeAwardingService`: the provider list below, shared by the event
 *   badge service and the winners listener.
 *
 * Exports nothing.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      QuizBadgeDefinition,
      QuizEventBadgeSlot,
      QuizGameWinner,
      QuizBadgeWin,
      RecognitionAward,
      Profile,
    ]),
    NotificationsModule,
    ModerationModule,
  ],
  controllers: [AdminQuizBadgesController, AdminQuizEventBadgesController],
  providers: [
    QuizBadgeLibraryService,
    QuizEventBadgesService,
    QuizBadgeAwardingService,
    QuizGameWinnersListener,
  ],
})
export class QuizWinBadgesModule {}
