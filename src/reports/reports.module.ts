import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Report } from './entities/report.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [TypeOrmModule.forFeature([Report])],
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
