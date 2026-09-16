import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { MentionsModule } from '../mentions/mentions.module';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report } from '../reports/entities/report.entity';
import { MessageEvidenceHoldSweepService } from './message-evidence-hold-sweep.service';
import { PreferencesModule } from '../preferences/preferences.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { ConversationMediaService } from './conversation-media.service';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import { GroupInvite } from './entities/group-invite.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import { GroupsService } from './groups.service';
import { GroupInvitesService } from './group-invites.service';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessageRequestsService } from './message-requests.service';
import { MessagesService } from './messages.service';
import {
  ConversationsController,
  MessageRequestController,
} from './messaging.controller';
import { MessagingCoreService } from './messaging-core.service';
import { MessagingService } from './messaging.service';

/**
 * The god `MessagingService` (2,565 lines) has been split into five
 * concern-scoped providers — `ConversationsService`, `MessagesService`,
 * `MessageAnnotationsService`, `GroupsService`, `MessageRequestsService` —
 * plus `MessagingCoreService`, the cross-cutting helper hub all five depend on
 * (singularly holds the `clearedAt`-floor `requireParticipant` and the
 * `toMessageResponses` hydration, so neither can diverge between concerns).
 * `MessagingService` remains registered/exported as a thin backward-compatible
 * facade — see its header comment.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,
      ConversationParticipant,
      ConversationPinnedMessage,
      GroupInvite,
      Message,
      MessageHide,
      MessageReaction,
      MessageStar,
      // ENG-245: `MessagesService.deleteMessage` writes the
      // `message_deleted_by_staff` audit row through the transaction's manager
      // and reads the cited `Report` to check it names the message. Registered
      // here as entities only (TypeORM permits the overlap with
      // `ModerationModule`/`ReportsModule`) rather than importing
      // `ModerationModule`, which WOULD cycle: `ModerationModule` imports
      // `AuthModule` -> `PushModule` -> `ChatModule` -> `MessagingModule`.
      ModAuditLog,
      Report,
    ]),
    UsersModule,
    ConnectionsModule,
    // Exports `BlockFilterService`, used to reject conversation/message-request
    // creation when either party has blocked the other (spec §2).
    SocialModule,
    // Re-exports `TypeOrmModule.forFeature([ContentModeration])`, so
    // `MessagingCoreService` can inject the moderation-state repository to
    // tombstone moderator-taken-down messages in thread reads.
    ContentModerationModule,
    // Batched crop lookup (`MediaCropService.getMany`) for a group's
    // `avatarUrl` sibling `avatarCrop`.
    MediaCropsModule,
    // Exports `MentionNotificationService` — `MessagesService.sendMessage`
    // fires it on every genuinely new send so an `@`-mention inside a DM/group
    // message notifies its target, mirroring forum/community posts. Plain
    // import, no `forwardRef`: `MentionsModule` does not depend on
    // `MessagingModule`.
    MentionsModule,
    // Exports `StorageService` so `MessagesService.deleteMessage` can delete
    // the BYTES behind a tombstoned message's attachment, not just hide it
    // from the timeline. Plain import, no `forwardRef`: `StorageModule` only
    // registers the `Message` ENTITY via its own `forFeature` (see its header)
    // and never imports `MessagingModule`, so no cycle is introduced.
    StorageModule,
    // Exports `PreferencesService` — PRD-364's reciprocal read-receipt sharing:
    // `ConversationsService.markRead` reads the reader's own share before
    // emitting `MESSAGE_READ`, and `MessagingCoreService.buildMemberSummaries`
    // (via `GroupsService`/`ConversationsService`) reads every group member's
    // share before surfacing their watermark to another viewer. No cycle:
    // `PreferencesModule` only reaches `ConnectionsModule`/`SubprofilesModule`/
    // `ContentModerationModule`/`VouchModule` (via `PublicEligibilityModule`),
    // none of which import `MessagingModule`.
    PreferencesModule,
  ],
  controllers: [ConversationsController, MessageRequestController],
  providers: [
    MessagingCoreService,
    ConversationsService,
    MessagesService,
    MessageAnnotationsService,
    GroupsService,
    // PRD-353/PRD-358: the invitee/owner-admin-initiated half of group
    // invites (accept/decline/revoke/list) plus the join-by-link flow. See
    // its own header doc for why it does not depend on `GroupsService`.
    GroupInvitesService,
    MessageRequestsService,
    MessagingService,
    // PRD-373: the per-conversation media, links and documents gallery.
    ConversationMediaService,
    // PRD-361: hourly release of expired evidence holds on deleted messages.
    MessageEvidenceHoldSweepService,
  ],
  exports: [
    MessagingService,
    MessagingCoreService,
    ConversationsService,
    MessagesService,
    MessageAnnotationsService,
    GroupsService,
    GroupInvitesService,
    MessageRequestsService,
  ],
})
export class MessagingModule {}
