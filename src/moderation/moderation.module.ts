import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { Listing } from '../listings/entities/listing.entity';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { AuthModule } from '../auth/auth.module';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsModule } from '../reports/reports.module';
import { UsersModule } from '../users/users.module';
import { Appeal } from './entities/appeal.entity';
import { BanRatification } from './entities/ban-ratification.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { BanRatificationService } from './ban-ratification.service';
import { AdminMemberModerationController } from './admin-member-moderation.controller';
import { AdminMemberModerationService } from './admin-member-moderation.service';
import { AppealsController } from './appeals.controller';
import { ModAuditService } from './mod-audit.service';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';
import { ReportSubjectResolverService } from './report-subject-resolver.service';

@Module({
  imports: [
    // AccountDeactivation: enforcement keeps an open deactivation row's
    // `previousStatus` in step, or a suspended member could launder the
    // suspension away by deactivating and signing back in. Written through the
    // transaction's `EntityManager` rather than an injected repository, so this
    // registration exists to guarantee the entity is loaded into the DataSource
    // for this module regardless of what `AuthModule`/`AccountModule` (which
    // both register it independently) do later. TypeORM permits the overlap.
    // `Listing` is registered read-only so a `listing`-subject report's detail
    // view can surface the live listing's pasted evidence (item #13). TypeORM
    // permits the same entity registered in multiple modules (mirrors the
    // `AccountDeactivation` overlap above); the listing domain itself is owned
    // by `ListingsModule`.
    TypeOrmModule.forFeature([
      Appeal,
      // TS-12: where a permanent ban waits for its second moderator.
      BanRatification,
      ModAuditLog,
      AccountDeactivation,
      Listing,
    ]),
    // Gets `Repository<Report>` via `ReportsModule`'s re-exported
    // `TypeOrmModule` rather than registering its own
    // `TypeOrmModule.forFeature([Report])` — see `reports.module.ts`.
    ReportsModule,
    // Gets `Repository<User>`/`Repository<Profile>` via `UsersModule`'s
    // re-exported `TypeOrmModule`, the same precedent, so the moderation
    // queue/detail/audit/appeals can resolve reporter/reported/actor names
    // without this module owning its own copy of those entities.
    UsersModule,
    // `AuthService.revokeAllForUser` — a suspended member's live refresh
    // tokens are killed so they cannot mint fresh access tokens. Not circular:
    // `AuthModule`'s own imports never reach moderation, and neither does the
    // import graph of the only other module that pulls this one in
    // (`ForumModule`, for the exported `ModAuditService` below). No
    // `forwardRef`.
    AuthModule,
    // `ContentModerationService.applyAction` — a `hide_content`/`remove_content`
    // action now writes the target content's takedown state in the SAME
    // transaction as the report status + audit row, closing the P3 gap where
    // those actions recorded an audit entry but left the content live.
    ContentModerationModule,
    // `NotificationsService` — tell a reporter their report was resolved, and
    // an appellant their appeal was decided. `NotificationsModule` imports only
    // `SocialModule`; nothing there reaches `ModerationModule`, so no cycle.
    NotificationsModule,
    // `CommunityMembershipService` — the community-owner/mod dismiss carve-out
    // on `PATCH /mod/reports/:id`: resolve a `post`/`reply` report subject to
    // its owning community, then check the acting member's roster role there.
    // Read-only, entity-registration-only module (no `CommunitiesModule`
    // import) — the same cross-feature reuse `EventsModule`/`ForumModule`/
    // `VolunteeringModule` already lean on it for. Closes no cycle.
    CommunityMembershipModule,
    AdminQueueNotificationsModule,
  ],
  // `AppealsController` (member-facing `POST /appeals`) shares `ModerationService`
  // with `ModerationController` (the mod/admin queue + review), so submitted
  // appeals land in the very same table the review path reads.
  // `AdminMemberModerationController` is the admin member-drawer Verify/Restrict
  // surface (P2-3) — `@Roles(Moderator, Admin)` on the shared `admin/members`
  // base path. It lives here (not in the admin-members module) because it
  // reuses this module's enforcement/audit/notification machinery rather than
  // duplicating the suspension model.
  controllers: [
    ModerationController,
    AppealsController,
    AdminMemberModerationController,
  ],
  // The extracted concerns are registered so Nest owns them as singletons and
  // injects them into `ModerationService`/`AdminMemberModerationService`.
  providers: [
    ModerationService,
    ModAuditService,
    AccountEnforcementService,
    AdminMemberModerationService,
    // `ReportSubjectResolverService` answers "who wrote this, what does it say,
    // which community owns it" for every report subject type. It is the shared
    // foundation under three behaviours: `warn` reaching the author of reported
    // content, `suspend`/`ban`/`restrict` landing on that author, and the queue
    // naming the community a report came from.
    //
    // NO MODULE IMPORT IS ADDED FOR IT, on purpose. The seventeen subject types
    // it covers span twelve feature modules, and importing them would create
    // real cycles: `CommunitiesModule` imports `ContentModerationModule`, which
    // this module also imports, and `ForumModule` imports THIS module for the
    // exported `ModAuditService`. The resolver injects only the shared
    // `DataSource` and reads through scoped, parameterized queries, so the
    // module graph is unchanged.
    ReportSubjectResolverService,
    // TS-12. Owns the pending-ratification queue, the ratify/decline decision,
    // and the lazy expiry of a hold nobody confirmed. It injects
    // `AccountEnforcementService` (to apply or undo the ban) rather than the
    // other way round; the enforcement service opens the hold row through the
    // `BanRatification` repository directly, so the two never form a service
    // cycle and no `forwardRef` is needed anywhere.
    BanRatificationService,
  ],
  // `ModAuditService` is the single writer into `mod_audit_logs` and the
  // reader behind `GET /mod/audit` + its CSV export. `ForumModule` imports
  // this module for it so staff thread actions (lock/unlock, pin/unpin, the
  // "QueerPulse Official" byline toggle) land in the same global audit feed as
  // every other moderator action instead of mutating state with no trail
  // (BE-COM-19). No cycle: `ForumModule` is not in this module's import graph.
  // `ModerationService`/`AccountEnforcementService`/
  // `AdminMemberModerationService` stay unexported — nothing outside consumes
  // them.
  exports: [ModAuditService],
})
export class ModerationModule {}
