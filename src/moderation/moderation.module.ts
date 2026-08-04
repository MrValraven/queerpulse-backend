import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { Listing } from '../listings/entities/listing.entity';
import { AuthModule } from '../auth/auth.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsModule } from '../reports/reports.module';
import { UsersModule } from '../users/users.module';
import { Appeal } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { AppealsController } from './appeals.controller';
import { ModAuditService } from './mod-audit.service';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';

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
    // nothing imports `ModerationModule` except `app.module.ts`, and
    // `AuthModule`'s own imports never reach moderation. No `forwardRef`.
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
  ],
  // `AppealsController` (member-facing `POST /appeals`) shares `ModerationService`
  // with `ModerationController` (the mod/admin queue + review), so submitted
  // appeals land in the very same table the review path reads.
  controllers: [ModerationController, AppealsController],
  // The two extracted concerns are registered so Nest owns them as singletons
  // and injects them into `ModerationService`. Nothing outside this module
  // consumes them (only `ModerationService` does), so they are not exported.
  providers: [ModerationService, ModAuditService, AccountEnforcementService],
})
export class ModerationModule {}
