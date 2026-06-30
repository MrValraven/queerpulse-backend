import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import storageConfig from './config/storage.config';
import { validate } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MembershipModule } from './membership/membership.module';
import { ProfilesModule } from './profiles/profiles.module';
import { VouchModule } from './vouch/vouch.module';
import { ConnectionsModule } from './connections/connections.module';
import { MessagingModule } from './messaging/messaging.module';
import { ChatModule } from './chat/chat.module';
import { EventsModule } from './events/events.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { CsrfGuard } from './security/csrf.guard';
import { SecurityModule } from './security/security.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, authConfig, storageConfig],
      validate,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: seconds(60), limit: 120 }],
    }),
    DatabaseModule,
    UsersModule,
    AuthModule,
    MembershipModule,
    ProfilesModule,
    VouchModule,
    ConnectionsModule,
    MessagingModule,
    ChatModule,
    EventsModule,
    NotificationsModule,
    StorageModule,
    HealthModule,
    SecurityModule,
  ],
  providers: [
    // CSRF first — validates double-submit independent of auth.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
