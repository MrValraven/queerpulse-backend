import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
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
import { PlatformSettingsModule } from './platform-settings/platform-settings.module';
import { ProfilesModule } from './profiles/profiles.module';
import { PublicProfilesModule } from './public-profiles/public-profiles.module';
import { SubprofilesModule } from './subprofiles/subprofiles.module';
import { HandlesModule } from './handles/handles.module';
import { VouchModule } from './vouch/vouch.module';
import { ConnectionsModule } from './connections/connections.module';
import { MessagingModule } from './messaging/messaging.module';
import { ChatModule } from './chat/chat.module';
import { CinemaModule } from './cinema/cinema.module';
import { CommunitiesModule } from './communities/communities.module';
import { CommunityModule } from './community/community.module';
import { ChangemakersModule } from './changemakers/changemakers.module';
import { CompaniesModule } from './companies/companies.module';
import { CultureModule } from './culture/culture.module';
import { GovernanceModule } from './governance/governance.module';
import { AdminCommunitiesModule } from './admin-communities/admin-communities.module';
import { AdminMembersModule } from './admin-members/admin-members.module';
import { AdminOverviewModule } from './admin-overview/admin-overview.module';
import { AdminBotsModule } from './admin-bots/admin-bots.module';
import { AdminHousingModule } from './admin-housing/admin-housing.module';
import { PlatformStaffModule } from './platform-staff/platform-staff.module';
import { EventsModule } from './events/events.module';
import { JobsModule } from './jobs/jobs.module';
import { WorkshopsModule } from './workshops/workshops.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PartnersModule } from './partners/partners.module';
import { StorageModule } from './storage/storage.module';
import { StorageKeyOwnershipInterceptor } from './storage/storage-key-ownership.interceptor';
import { UsersModule } from './users/users.module';
import { VolunteeringModule } from './volunteering/volunteering.module';
import { CsrfGuard } from './security/csrf.guard';
import { HttpThrottlerGuard } from './security/http-throttler.guard';
import { SecurityModule } from './security/security.module';
import { SocialModule } from './social/social.module';
import { ReportsModule } from './reports/reports.module';
import { ModerationModule } from './moderation/moderation.module';
import { AccountModule } from './account/account.module';
import { ConsentModule } from './consent/consent.module';
import { SavedModule } from './saved/saved.module';
import { PreferencesModule } from './preferences/preferences.module';
import { DraftsModule } from './drafts/drafts.module';
import { RecognitionModule } from './recognition/recognition.module';
import { AffiliationModule } from './affiliation/affiliation.module';
import { ForumModule } from './forum/forum.module';
import { FeedModule } from './feed/feed.module';
import { HousingModule } from './housing/housing.module';
import { HousingListingsModule } from './housing-listings/housing-listings.module';
import { FlatmateProfilesModule } from './flatmate-profiles/flatmate-profiles.module';
import { LandlordsModule } from './landlords/landlords.module';
import { ListingsModule } from './listings/listings.module';
import { MagazineModule } from './magazine/magazine.module';
import { ResourcesModule } from './resources/resources.module';
import { ContentModule } from './content/content.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { GenesisModule } from './genesis/genesis.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CommonModule } from './common/common.module';
import { LaunchedFeaturesGuard } from './common/launched-features.guard';
import { PlatformLockdownGuard } from './common/platform-lockdown.guard';

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
        // Never log credentials. Largely redundant now that the serializers
        // below drop headers entirely, but kept as defense-in-depth for the
        // prod JSON path in case a serializer is ever widened.
        redact: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
        ],
        // Emit the level as its label ("info"/"warn"/"error") rather than
        // pino's default numeric level (30/40/50). Railway's log explorer
        // detects severity from a string `level` attribute; it can't map the
        // numbers, so without this every JSON line falls back to Info.
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        // Log only essential fields per request. reqId and responseTime are
        // emitted at the top level by pino-http and survive automatically.
        serializers: {
          req: (req: IncomingMessage) => ({
            method: req.method,
            url: req.url,
          }),
          res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
          err: (err: Error & { type?: string }) => ({
            type: err.type,
            message: err.message,
            stack: err.stack,
          }),
        },
        // Suppress 304 cache-hits ('silent' skips emission) and map status to
        // level so failures stand out (warn/error) while success stays info.
        customLogLevel: (
          _req: IncomingMessage,
          res: ServerResponse,
          err?: Error,
        ) => {
          if (res.statusCode === 304) return 'silent';
          if (res.statusCode >= 500 || err) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // pino-pretty is a devDependency and is absent from the production
        // image, so selecting it there throws at boot ("unable to determine
        // transport target") before a logger exists to report why. Keying that
        // off `NODE_ENV !== 'production'` made a boot crash reachable by setting
        // NODE_ENV=staging in a dashboard; require an explicit opt-in instead.
        // LOG_PRETTY=true in a deployed environment is the caller's problem.
        transport:
          process.env.LOG_PRETTY === 'true' ||
          (process.env.LOG_PRETTY === undefined &&
            process.env.NODE_ENV === 'development')
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    // SINGLE-REPLICA ONLY. No `storage` is configured, so @nestjs/throttler
    // falls back to an in-process Map: counters reset on every deploy, and with
    // N replicas every limit becomes N× its stated value — including the 10/60s
    // on POST /auth/refresh, which is the only abuse control on that endpoint.
    // Scaling out requires a shared store (e.g. @nest-lab/throttler-storage-redis)
    // here AND a socket.io Redis adapter — see the note in ChatGateway.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: seconds(60), limit: 120 }],
    }),
    DatabaseModule,
    CommonModule,
    PlatformSettingsModule,
    UsersModule,
    AuthModule,
    MembershipModule,
    ProfilesModule,
    PublicProfilesModule,
    SubprofilesModule,
    HandlesModule,
    VouchModule,
    ConnectionsModule,
    MessagingModule,
    ChatModule,
    EventsModule,
    CommunitiesModule,
    CompaniesModule,
    JobsModule,
    WorkshopsModule,
    PartnersModule,
    VolunteeringModule,
    NotificationsModule,
    StorageModule,
    CinemaModule,
    HealthModule,
    SecurityModule,
    SocialModule,
    ReportsModule,
    ModerationModule,
    AccountModule,
    ConsentModule,
    SavedModule,
    BootstrapModule,
    GenesisModule,
    PreferencesModule,
    DraftsModule,
    RecognitionModule,
    AffiliationModule,
    ForumModule,
    FeedModule,
    ListingsModule,
    HousingModule,
    HousingListingsModule,
    FlatmateProfilesModule,
    LandlordsModule,
    MagazineModule,
    ResourcesModule,
    ContentModule,
    CultureModule,
    GovernanceModule,
    CommunityModule,
    ChangemakersModule,
    AdminCommunitiesModule,
    AdminMembersModule,
    AdminOverviewModule,
    AdminBotsModule,
    AdminHousingModule,
    PlatformStaffModule,
  ],
  providers: [
    // Guards run in registration order. Throttle first (cheapest, and it must
    // count requests that CSRF/JWT would otherwise reject before they do), then
    // the launched-feature gate (an unlaunched feature 404s before auth runs,
    // so callers get "not available yet" instead of a misleading 401/403), then
    // CSRF (double-submit, independent of auth), then JWT authentication, and
    // finally the platform kill switch — which must run last because it is the
    // only guard that needs `req.user.role`, populated by JwtAuthGuard.
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
    { provide: APP_GUARD, useClass: LaunchedFeaturesGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PlatformLockdownGuard },
    // Adds error logging + Sentry capture, then defers to Nest's default filter.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Runs after the guards above (interceptors run after guards in the Nest
    // lifecycle), so `request.user` is populated. Rejects any request whose
    // body references a storage key it did not upload — see the invariant
    // documented at the top of the interceptor itself.
    { provide: APP_INTERCEPTOR, useClass: StorageKeyOwnershipInterceptor },
  ],
})
export class AppModule {}
