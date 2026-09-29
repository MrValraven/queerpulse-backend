import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { Connection } from '../connections/entities/connection.entity';
import { EventBan } from '../events/entities/event-ban.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Event } from '../events/entities/event.entity';
import { EventsModule } from '../events/events.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OfficialMessagesModule } from '../official-messages/official-messages.module';
import { Block } from '../social/entities/block.entity';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import { MatchAvoidance } from './entities/match-avoidance.entity';
import { MatchFeedback } from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { MatchTrainingRow } from './entities/match-training-row.entity';
import { GoTogetherEligibilityService } from './go-together-eligibility.service';
import { GoTogetherEntryService } from './go-together-entry.service';
import { GoTogetherEventController } from './go-together-event.controller';
import { GoTogetherFormationService } from './go-together-formation.service';
import { GoTogetherHostService } from './go-together-host.service';
import { GoTogetherHouseService } from './go-together-house.service';
import { GoTogetherPoolService } from './go-together-pool.service';
import { GoTogetherProfileController } from './go-together-profile.controller';
import { GoTogetherProfileService } from './go-together-profile.service';
import { GoTogetherFeedbackService } from './go-together-feedback.service';
import { GoTogetherGroupService } from './go-together-group.service';
import { GoTogetherGroupsController } from './go-together-groups.controller';
import { GoTogetherListener } from './go-together.listener';
import { GoTogetherMatchingService } from './go-together-matching.service';

/**
 * Go together: friend matching for members attending a gathering alone or
 * with one friend. Design spec: QUEERPULSE-GO-TOGETHER-DESIGN-2026-09-28.md.
 * Controllers and providers are registered by the coordinator as tasks land.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FriendMatchProfile,
      EventMatchConfig,
      EventMatchEntry,
      EventMatchGroup,
      MatchFeedback,
      MatchGroupFeedback,
      MatchAvoidance,
      MatchTrainingRow,
      // Other modules' entities read directly for batched pool queries.
      Event,
      EventRsvp,
      EventBan,
      Profile,
      User,
      Block,
      Connection,
    ]),
    UsersModule,
    EventsModule,
    NotificationsModule,
    SocialModule,
    ConnectionsModule,
    MessagingModule,
    OfficialMessagesModule,
    VerificationModule,
  ],
  controllers: [
    GoTogetherProfileController,
    GoTogetherEventController,
    GoTogetherGroupsController,
  ],
  providers: [
    GoTogetherProfileService,
    GoTogetherHouseService,
    GoTogetherEligibilityService,
    GoTogetherHostService,
    GoTogetherEntryService,
    GoTogetherPoolService,
    GoTogetherFormationService,
    GoTogetherMatchingService,
    GoTogetherGroupService,
    GoTogetherFeedbackService,
    GoTogetherListener,
  ],
  exports: [
    GoTogetherProfileService,
    GoTogetherHouseService,
    GoTogetherEligibilityService,
    GoTogetherFormationService,
  ],
})
export class GoTogetherModule {}
