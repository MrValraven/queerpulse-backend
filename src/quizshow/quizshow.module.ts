import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { FeatureAccessModule } from '../early-access/feature-access.module';
import { ModerationModule } from '../moderation/moderation.module';
import { Event } from '../events/entities/event.entity';
import { EventBan } from '../events/entities/event-ban.entity';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { PushModule } from '../push/push.module';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { QuizshowAnswerRecord } from './entities/quizshow-answer.entity';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowResultRecord } from './entities/quizshow-result.entity';
import { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowTeamRecord } from './entities/quizshow-team.entity';
import { QuizshowTemplateRecord } from './entities/quizshow-template.entity';
import { QuizshowVoteRecord } from './entities/quizshow-vote.entity';
import { AdminQuizshowController } from './admin-quizshow.controller';
import { AdminQuizshowTemplatesController } from './admin-quizshow-templates.controller';
import { QuizshowAccessService } from './quizshow-access.service';
import { QuizshowDevicePairingService } from './quizshow-device-pairing.service';
import { QuizshowDevicesController } from './quizshow-devices.controller';
import { QuizshowEventController } from './quizshow-event.controller';
import { QuizshowEventLifecycleListener } from './quizshow-event-lifecycle.listener';
import { QuizshowGamesController } from './quizshow-games.controller';
import { QuizshowGamesService } from './quizshow-games.service';
import { QuizshowGuestPushService } from './quizshow-guest-push.service';
import { QuizshowPersistenceService } from './quizshow-persistence.service';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { QuizshowRetentionService } from './quizshow-retention.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import { QuizshowSessionsService } from './quizshow-sessions.service';
import { QuizshowTemplatesService } from './quizshow-templates.service';
import { QuizshowController } from './quizshow.controller';
import { QuizshowGateway } from './quizshow.gateway';
import { QuizshowLobbyOpenRecord } from './entities/quizshow-lobby-open.entity';

/**
 * Pulse Live (`quizshow`): live quiz and party games on events, and games
 * without an event that a member owns, and the staff templates hosts import
 * from. Join is open to every active member
 * before launch; hosting stays behind the feature gate. A TV pairs as a
 * screen and a member's phone as a helper remote; the screen start and the
 * signed-out join preview are public and open at launch.
 *
 * Module edges: `QuizshowModule` imports `EventsModule`; `EventsModule` and
 * `ReportsModule` reach quizshow through dependency-free helpers and one
 * event, so no cycle. The other imports (`SocialModule`, `PushModule`,
 * `NotificationsModule`, `PlatformSettingsModule`, `FeatureAccessModule`,
 * `ModerationModule`) reach nothing that imports this module. Nothing is
 * exported.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      QuizshowQuizRecord,
      QuizshowRoundRecord,
      QuizshowQuestionRecord,
      QuizshowSessionRecord,
      QuizshowTeamRecord,
      QuizshowPlayerRecord,
      QuizshowAnswerRecord,
      QuizshowVoteRecord,
      QuizshowResultRecord,
      // The lobby rate limit's ledger; it outlives the games it counts.
      QuizshowLobbyOpenRecord,
      QuizshowTemplateRecord,
      Event,
      EventBan,
      User,
      Profile,
      // Read-side only: the socket handshake asks whether the session behind
      // the access token is still live, as `ChatGateway` does.
      RefreshToken,
    ]),
    // The gateway verifies the handshake token itself and passes the secret
    // on each call, as `ChatGateway` does, so no defaults. The device pairing
    // service signs and verifies device tickets the same way, with its own key.
    JwtModule.register({}),
    // `EventsService`: `assertCanView` and `isOrganizer`.
    EventsModule,
    // `BlockFilterService`: a block either way with the event host bars a
    // member from the event's sessions.
    SocialModule,
    // `PushPreviewPrivacyService`: the lobby-opened push to going guests.
    PushModule,
    // `NotificationPreferencesService` and `NotificationDeliveryService`:
    // the guest push honours preferences and quiet hours.
    NotificationsModule,
    // `PlatformSettingsService`: the socket handshake applies the
    // platform-lockdown rule, as `ChatGateway` does.
    PlatformSettingsModule,
    // `FeatureAccessService`: the socket handshake admits every active member
    // while Pulse Live is launched or in early access; host and screen roles,
    // `session:reauth` of those roles and the guest push need the grant.
    // Entity-only, so no cycle.
    FeatureAccessModule,
    // `ModAuditService`: staff ending or deleting a reported game write a
    // moderation audit row. `ModerationModule` never imports this module.
    ModerationModule,
  ],
  controllers: [
    QuizshowEventController,
    QuizshowGamesController,
    AdminQuizshowController,
    AdminQuizshowTemplatesController,
    QuizshowController,
    // Device pairing starts and claims, and the signed-out join preview.
    QuizshowDevicesController,
  ],
  providers: [
    QuizshowAccessService,
    QuizshowQuizService,
    QuizshowGamesService,
    QuizshowTemplatesService,
    QuizshowSessionsService,
    QuizshowGuestPushService,
    QuizshowPersistenceService,
    QuizshowRuntimeService,
    // Namespace `/quizshow`.
    QuizshowGateway,
    // The daily idle-session sweep and the expired-plays purge (`@Cron`).
    QuizshowRetentionService,
    // Abandons open sessions on `EVENT_CANCELLED` and `EVENT_DELETING`.
    QuizshowEventLifecycleListener,
    // Pending TV and helper pairings (memory only) and device tickets; the
    // gateway in this module reaches it, so no export.
    QuizshowDevicePairingService,
  ],
})
export class QuizshowModule {}
