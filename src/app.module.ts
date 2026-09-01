import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
import loggingConfig from './config/logging.config';
import muxConfig from './config/mux.config';
import pushConfig from './config/push.config';
import retentionConfig from './config/retention.config';
import storageConfig from './config/storage.config';
import { validate } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { MembershipCardsModule } from './membership-cards/membership-cards.module';
import { MembershipModule } from './membership/membership.module';
import { PlatformSettingsModule } from './platform-settings/platform-settings.module';
import { ProfilesModule } from './profiles/profiles.module';
import { PublicProfilesModule } from './public-profiles/public-profiles.module';
import { SubprofilesModule } from './subprofiles/subprofiles.module';
import { HandlesModule } from './handles/handles.module';
import { VouchModule } from './vouch/vouch.module';
import { ConnectionsModule } from './connections/connections.module';
import { MessagingModule } from './messaging/messaging.module';
import { LinkPreviewModule } from './link-preview/link-preview.module';
import { ChatModule } from './chat/chat.module';
import { CinemaModule } from './cinema/cinema.module';
import { CommunitiesModule } from './communities/communities.module';
import { ReadingGroupProposalsModule } from './reading-group-proposals/reading-group-proposals.module';
import { ChangemakersModule } from './changemakers/changemakers.module';
import { CompaniesModule } from './companies/companies.module';
import { CultureModule } from './culture/culture.module';
import { GovernanceModule } from './governance/governance.module';
import { RoadmapModule } from './roadmap/roadmap.module';
import { LandingModule } from './landing/landing.module';
import { PressKitModule } from './press-kit/press-kit.module';
import { AdminCommunitiesModule } from './admin-communities/admin-communities.module';
import { AdminMembersModule } from './admin-members/admin-members.module';
import { AdminDsarModule } from './admin-dsar/admin-dsar.module';
import { AdminStatusModule } from './admin-status/admin-status.module';
import { StatusModule } from './status/status.module';
import { AdminInvitesModule } from './admin-invites/admin-invites.module';
import { BanEvasionModule } from './ban-evasion/ban-evasion.module';
import { ModResponseTemplatesModule } from './mod-response-templates/mod-response-templates.module';
import { LegalRequestsModule } from './legal-requests/legal-requests.module';
import { TransparencyModule } from './transparency/transparency.module';
import { AdminTopicsModule } from './admin-topics/admin-topics.module';
import { AdminTrustNetworkModule } from './admin-trust-network/admin-trust-network.module';
import { AdminOverviewModule } from './admin-overview/admin-overview.module';
import { AdminModerationHealthModule } from './admin-moderation-health/admin-moderation-health.module';
import { AdminQueueNotificationsModule } from './admin-queue-notifications/admin-queue-notifications.module';
import { AdminReportsModule } from './admin-reports/admin-reports.module';
import { AdminMediaModule } from './admin-media/admin-media.module';
import { MyMediaModule } from './my-media/my-media.module';
import { AdminBotsModule } from './admin-bots/admin-bots.module';
import { AdminForumModule } from './admin-forum/admin-forum.module';
import { AdminHousingModule } from './admin-housing/admin-housing.module';
import { PlatformStaffModule } from './platform-staff/platform-staff.module';
import { PublicEligibilityModule } from './public-eligibility/public-eligibility.module';
import { PushModule } from './push/push.module';
import { EventsModule } from './events/events.module';
import { CalendarFeedModule } from './calendar-feed/calendar-feed.module';
import { JobsModule } from './jobs/jobs.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PartnersModule } from './partners/partners.module';
import { OrgTiersModule } from './org-tiers/org-tiers.module';
import { StorageModule } from './storage/storage.module';
import { StorageKeyOwnershipInterceptor } from './storage/storage-key-ownership.interceptor';
import { UsersModule } from './users/users.module';
import { VolunteeringModule } from './volunteering/volunteering.module';
import { BarterModule } from './barter/barter.module';
import { CsrfGuard } from './security/csrf.guard';
import { HttpThrottlerGuard } from './security/http-throttler.guard';
import { SecurityModule } from './security/security.module';
import { SocialModule } from './social/social.module';
import { ReportsModule } from './reports/reports.module';
import { ContentModerationModule } from './content-moderation/content-moderation.module';
import { ModerationModule } from './moderation/moderation.module';
import { AccountModule } from './account/account.module';
import { ConsentModule } from './consent/consent.module';
import { NudgesModule } from './nudges/nudges.module';
import { SavedModule } from './saved/saved.module';
import { CollectionsModule } from './collections/collections.module';
import { MemberSuggestionsModule } from './member-suggestions/member-suggestions.module';
import { TopicsModule } from './topics/topics.module';
import { NewsletterModule } from './newsletter/newsletter.module';
import { SafeSpaceNominationsModule } from './safe-space-nominations/safe-space-nominations.module';
import { SafeSpaceVouchesModule } from './safe-space-vouches/safe-space-vouches.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { IntakesModule } from './intakes/intakes.module';
import { PreferencesModule } from './preferences/preferences.module';
import { DraftsModule } from './drafts/drafts.module';
import { ListingDraftsModule } from './listing-drafts/listing-drafts.module';
import { RecognitionModule } from './recognition/recognition.module';
import { AffiliationModule } from './affiliation/affiliation.module';
import { ForumModule } from './forum/forum.module';
import { FeedModule } from './feed/feed.module';
import { HousingModule } from './housing/housing.module';
import { HousingGroupsModule } from './housing-groups/housing-groups.module';
import { HousingListingsModule } from './housing-listings/housing-listings.module';
import { HousingViewingsModule } from './housing-viewings/housing-viewings.module';
import { HousingReviewsModule } from './housing-reviews/housing-reviews.module';
import { HousingSavedSearchesModule } from './housing-saved-searches/housing-saved-searches.module';
import { FlatmateProfilesModule } from './flatmate-profiles/flatmate-profiles.module';
import { LandlordsModule } from './landlords/landlords.module';
import { VerificationModule } from './verification/verification.module';
import { AffirmingPledgeModule } from './affirming-pledge/affirming-pledge.module';
import { ListingsModule } from './listings/listings.module';
import { SearchModule } from './search/search.module';
import { GeocodeModule } from './geocode/geocode.module';
import { MagazineModule } from './magazine/magazine.module';
import { ResourcesModule } from './resources/resources.module';
import { ContentModule } from './content/content.module';
import { SubmissionsModule } from './submissions/submissions.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { GenesisModule } from './genesis/genesis.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CommonModule } from './common/common.module';
import { LaunchedFeaturesGuard } from './common/launched-features.guard';
import { PlatformLockdownGuard } from './common/platform-lockdown.guard';
import { redactSensitiveQueryParameters } from './common/redact-url';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [
        appConfig,
        databaseConfig,
        loggingConfig,
        authConfig,
        storageConfig,
        muxConfig,
        pushConfig,
        retentionConfig,
      ],
      validate,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get<string>('logging.level'),
          // Correlate every request with an id (honour an inbound one behind a proxy).
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const inbound = req.headers['x-request-id'];
            const id =
              (Array.isArray(inbound) ? inbound[0] : inbound) ?? randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Never log credentials carried in a HEADER. Largely redundant now
          // that the serializers below drop headers entirely, but kept as
          // defense-in-depth for the prod JSON path in case a serializer is
          // ever widened. Credentials carried in the QUERY STRING are a
          // separate problem this list cannot address; see the note on the req
          // serializer below.
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
          //
          // The URL goes through `redactSensitiveQueryParameters` because the
          // header redaction above could never reach it: several credentials
          // on this platform ride in the QUERY STRING rather than in a header,
          // since the browser carries them across a plain navigation where no
          // header and no body exist. `GET /auth/google?invite=<code>` was the
          // clearest case, writing an account-creating invite code into the log
          // store on every sign-in through an invite link. Redaction is narrow
          // on purpose: parameter names and every non-sensitive value stay
          // readable, so the URL keeps the debugging value it is logged for.
          // The full list and its justification live in `common/redact-url.ts`.
          serializers: {
            req: (req: IncomingMessage) => ({
              method: req.method,
              url: redactSensitiveQueryParameters(req.url),
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
          // The LOG_PRETTY opt-in and its rationale live in logging.config.ts.
          transport: configService.get<boolean>('logging.pretty')
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        },
      }),
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
    MembershipCardsModule,
    MembershipModule,
    ProfilesModule,
    PublicProfilesModule,
    SubprofilesModule,
    HandlesModule,
    VouchModule,
    SafeSpaceNominationsModule,
    SafeSpaceVouchesModule,
    ConnectionsModule,
    MessagingModule,
    LinkPreviewModule,
    ChatModule,
    EventsModule,
    CalendarFeedModule,
    CommunitiesModule,
    CompaniesModule,
    JobsModule,
    PartnersModule,
    InquiriesModule,
    OrgTiersModule,
    VolunteeringModule,
    BarterModule,
    NotificationsModule,
    PushModule,
    StorageModule,
    CinemaModule,
    HealthModule,
    MetricsModule,
    SecurityModule,
    SocialModule,
    ReportsModule,
    ContentModerationModule,
    ModerationModule,
    AccountModule,
    ConsentModule,
    NudgesModule,
    SavedModule,
    CollectionsModule,
    IntakesModule,
    NewsletterModule,
    BootstrapModule,
    GenesisModule,
    PreferencesModule,
    DraftsModule,
    ListingDraftsModule,
    RecognitionModule,
    AffiliationModule,
    ForumModule,
    FeedModule,
    ListingsModule,
    SearchModule,
    GeocodeModule,
    HousingModule,
    HousingGroupsModule,
    HousingListingsModule,
    HousingViewingsModule,
    HousingReviewsModule,
    HousingSavedSearchesModule,
    FlatmateProfilesModule,
    LandlordsModule,
    VerificationModule,
    AffirmingPledgeModule,
    MagazineModule,
    ResourcesModule,
    TopicsModule,
    // "Members you might know" (SOC-05). Its controller is
    // `members/suggested`, a literal segment ProfilesController does not claim,
    // so module order does not affect routing.
    MemberSuggestionsModule,
    ContentModule,
    // PRD-48. The shared intake primitive: no controller and no entity, only
    // the two notifiers (`SubmissionDecisionNotifier`, `ReviewReplyNotifier`)
    // that every submission surface uses to tell the person who submitted what
    // happened. Registered here so the module instantiates on its own; the
    // feature modules that emit import it directly.
    SubmissionsModule,
    CultureModule,
    GovernanceModule,
    RoadmapModule,
    ReadingGroupProposalsModule,
    ChangemakersModule,
    LandingModule,
    PressKitModule,
    AdminCommunitiesModule,
    AdminMembersModule,
    AdminInvitesModule,
    // A privacy-preserving signal that a new account may belong to someone
    // already removed (TS-05). Read-only: it raises a flag for a human
    // reviewer in the invite console and never blocks anyone by itself.
    BanEvasionModule,
    // The reason-keyed library moderators prefill a decision note from
    // (TS-16). No template id is ever stored on an action, so editing a
    // template later cannot rewrite what a member was already told.
    ModResponseTemplatesModule,
    // The public, aggregate-only transparency report the constitution names
    // but never had (TS-13).
    TransparencyModule,
    // The admin-only register of legal, government and law-enforcement
    // demands for member data (PRD-32). The report above publishes the
    // aggregate over it; nothing else reads the table.
    LegalRequestsModule,
    AdminDsarModule,
    AdminStatusModule,
    StatusModule,
    // Staff CRUD for the topic directory (SOC-01). Routes live under
    // /admin/topics, which no other controller claims.
    AdminTopicsModule,
    AdminTrustNetworkModule,
    AdminOverviewModule,
    // Moderator workload and SLA alerting (TS-04). Registering it starts the
    // hourly queue-health cron as well as opening
    // /admin/moderation/queue-health, which is why it is named here in its own
    // right rather than folded into AdminOverviewModule.
    AdminModerationHealthModule,
    AdminQueueNotificationsModule,
    AdminReportsModule,
    AdminMediaModule,
    MyMediaModule,
    AdminBotsModule,
    AdminForumModule,
    AdminHousingModule,
    PlatformStaffModule,
    PublicEligibilityModule,
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
