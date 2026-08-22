import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConnectionsModule } from '../connections/connections.module';
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
