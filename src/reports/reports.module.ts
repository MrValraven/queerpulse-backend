import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../messaging/entities/message.entity';
import { Report } from './entities/report.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Report,
      // Read-only: backs the message self-report guard in `ReportsService`.
      // Registered here directly (not via `MessagingModule`) to avoid a
      // module cycle — `MessagingModule` imports `SocialModule`, which
      // imports `ReportsModule`. TypeORM allows the same entity's repository
      // to be registered in more than one module (see `AccountModule`).
      Message,
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  // `ModerationModule` imports `ReportsModule` (not its own
  // `TypeOrmModule.forFeature([Report])`) to get `Repository<Report>` for
  // its queue/detail/status-update/audit endpoints — mirrors
  // `UsersModule`'s `exports: [TypeOrmModule, UsersService]` precedent for
  // cross-module entity access.
  exports: [TypeOrmModule, ReportsService],
})
export class ReportsModule {}
