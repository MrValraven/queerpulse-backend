import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, seconds } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import muxConfig from './config/mux.config';
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
import { CinemaModule } from './cinema/cinema.module';
import { EventsModule } from './events/events.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { CsrfGuard } from './security/csrf.guard';
import { HttpThrottlerGuard } from './security/http-throttler.guard';
import { SecurityModule } from './security/security.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, authConfig, storageConfig, muxConfig],
      validate,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level:
          process.env.LOG_LEVEL ??
          (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        // Correlate every request with an id (honour an inbound one behind a proxy).
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const inbound = req.headers['x-request-id'];
          const id =
            (Array.isArray(inbound) ? inbound[0] : inbound) ?? randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        // Never log credentials.
        redact: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
        ],
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
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
    CinemaModule,
    HealthModule,
    SecurityModule,
  ],
  providers: [
    // Guards run in registration order. Throttle first (cheapest, and it must
    // count requests that CSRF/JWT would otherwise reject before they do), then
    // CSRF (double-submit, independent of auth), then JWT authentication.
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Adds error logging + Sentry capture, then defers to Nest's default filter.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
