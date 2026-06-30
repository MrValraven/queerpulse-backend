import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConnectionsModule } from '../connections/connections.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';

@Module({
  imports: [
    MessagingModule,
    ConnectionsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtAccessSecret'),
      }),
    }),
  ],
  providers: [ChatGateway, PresenceService],
})
export class ChatModule {}
