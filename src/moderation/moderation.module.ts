import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { AuthModule } from '../auth/auth.module';
import { ReportsModule } from '../reports/reports.module';
import { UsersModule } from '../users/users.module';
import { Appeal } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
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
    TypeOrmModule.forFeature([Appeal, ModAuditLog, AccountDeactivation]),
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
  ],
  controllers: [ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
