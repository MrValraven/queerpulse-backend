import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { IdentitiesModule } from '../identities/identities.module';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { PreferencesModule } from '../preferences/preferences.module';
import { SocialModule } from '../social/social.module'; // provides BlockFilterService (PRD-354: fan-out block filter)
import { UsersModule } from '../users/users.module';
import { ChatGateway } from './chat.gateway';
import { ChatSessionEnforcementService } from './chat-session-enforcement.service';
import { ChatSingleInstanceGuard } from './chat-single-instance.guard';
import { ChatGatewayInstanceHeartbeat } from './entities/chat-gateway-instance-heartbeat.entity';
import { MailboxStaffRelayListener } from './mailbox-staff-relay.listener';
import { PresenceService } from './presence.service';

@Module({
  imports: [
    MessagingModule,
    ConnectionsModule,
    // Task 13: `ChatGateway`'s typing relay resolves the sender's SEAT
    // identity (`conversation_participants.identity_id`) through
    // `IdentitiesService.getById`/`describeIdentities`/`staffUserIds`, the
    // same batched service `ConversationsService` and `MessagingCoreService`
    // already use, so there is exactly one "what is this identity" lookup
    // in the codebase. `MessagingModule` imports `IdentitiesModule` too but
    // does not re-export `IdentitiesService`, so this gateway imports it
    // directly here. No cycle: `IdentitiesModule` registers only its own
    // entities and imports nothing from `ChatModule`.
    IdentitiesModule,
    UsersModule,
    PlatformSettingsModule,
    // Exports `PreferencesService` — PRD-364's reciprocal read-receipt/typing/
    // presence sharing gates `ChatGateway`'s typing relay, read relay, and
    // every presence broadcast/snapshot. No cycle (see `MessagingModule`'s
    // identical import for the reachability argument).
    PreferencesModule,
    // PRD-354: `ChatGateway.fanOutConversationMessage` skips a GROUP
    // participant blocked either way with the sender, via
    // `BlockFilterService.blockedUserIds` (one batched query, mirroring
    // `PushMessageListener`'s identical import, `push.module.ts`). Only
    // imports `UsersModule` + `ReportsModule` + TypeORM itself, neither of
    // which ever imports `ChatModule`, so this stays a one-way import.
    SocialModule,
    // RefreshToken, read-side only: `ChatGateway.authenticate` asks whether the
    // refresh-token family named by the access token's `sid` claim is still
    // live, so a device the member signed out on the security page cannot walk
    // back in through a WebSocket handshake for the rest of its access-token
    // TTL. `AuthService` owns every write to this table and registers its own
    // copy; this is the same read-side registration pattern `AuthModule` uses
    // for entities other modules own. Importing `AuthModule` instead would pull
    // membership, vouch, connections and media-crops into the chat graph for
    // one `exists` query.
    //
    // ConversationParticipant, also read-side only: `ChatGateway`'s ENG-160
    // per-recipient fan-out (`fanOutConversationMessage`) needs a
    // conversationId-indexed participant list to reach members who haven't
    // joined the conversation's socket room. Same read-side registration
    // pattern as `RefreshToken` above (and `PushMessageListener`'s identical
    // registration in `push.module.ts` for the same entity/query shape) rather
    // than importing the owning module for one query.
    //
    // ChatGatewayInstanceHeartbeat, owned entirely by this module (ENG-258):
    // `ChatSingleInstanceGuard` both writes (its own heartbeat) and reads
    // (its runtime scale-out detection) this table, see the entity's own
    // doc.
    TypeOrmModule.forFeature([
      RefreshToken,
      ConversationParticipant,
      ChatGatewayInstanceHeartbeat,
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtAccessSecret'),
      }),
    }),
  ],
  providers: [
    ChatGateway,
    ChatSessionEnforcementService,
    // Asserts the single-replica assumption every provider above quietly makes
    // (in-memory presence, in-memory WS buckets, process-local socket.io rooms)
    // at boot instead of leaving it as a comment. See its doc for what a real
    // horizontal scale-out needs.
    ChatSingleInstanceGuard,
    PresenceService,
    // Task 19: staff-only business mailbox frames (`conversation:claim`),
    // emitted through `ChatGateway.namespace`. Reads `Profile` through the
    // repository `UsersModule` already exports, and `ConversationParticipant`
    // through the registration above.
    MailboxStaffRelayListener,
  ],
  exports: [PresenceService],
})
export class ChatModule {}
