import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { UsersModule } from '../users/users.module';
import { ChatGateway } from './chat.gateway';
import { ChatSessionEnforcementService } from './chat-session-enforcement.service';
import { ChatSingleInstanceGuard } from './chat-single-instance.guard';
import { PresenceService } from './presence.service';

@Module({
  imports: [
    MessagingModule,
    ConnectionsModule,
    UsersModule,
    PlatformSettingsModule,
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
    TypeOrmModule.forFeature([RefreshToken, ConversationParticipant]),
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
  ],
  exports: [PresenceService],
})
export class ChatModule {}
