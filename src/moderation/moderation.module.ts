import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsModule } from '../reports/reports.module';
import { UsersModule } from '../users/users.module';
import { Appeal } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Appeal, ModAuditLog]),
    // Gets `Repository<Report>` via `ReportsModule`'s re-exported
    // `TypeOrmModule` rather than registering its own
    // `TypeOrmModule.forFeature([Report])` — see `reports.module.ts`.
    ReportsModule,
    // Gets `Repository<User>`/`Repository<Profile>` via `UsersModule`'s
    // re-exported `TypeOrmModule`, the same precedent, so the moderation
    // queue/detail/audit/appeals can resolve reporter/reported/actor names
    // without this module owning its own copy of those entities.
    UsersModule,
  ],
  controllers: [ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
