import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Message } from '../messaging/entities/message.entity';
import { StorageModule } from '../storage/storage.module';
import { Report } from './entities/report.entity';
import { ReportFilingThrottlerGuard } from './report-filing-throttler.guard';
import { ReportPhotoEvidenceController } from './report-photo-evidence.controller';
import reportsConfig from './reports.config';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    // The anonymous flood-cap pepper is registered as a feature namespace
    // rather than added to the root `load` array, so this module stays
    // self-contained — the same shape `BanEvasionModule` uses for its own
    // pepper. `ConfigModule` is global, so `ConfigService` injects into
    // `ReportsService` without anything else being imported.
    ConfigModule.forFeature(reportsConfig),
    TypeOrmModule.forFeature([
      Report,
      // Read-only: backs the message self-report guard in `ReportsService`.
      // Registered here directly (not via `MessagingModule`) to avoid a
      // module cycle — `MessagingModule` imports `SocialModule`, which
      // imports `ReportsModule`. TypeORM allows the same entity's repository
      // to be registered in more than one module (see `AccountModule`).
      Message,
      // Read-only: backs the housing-listing evidence snapshot in
      // `ReportsService` (P0.9). Same cross-module `forFeature` reuse.
      HousingListing,
      // Read-only: backs the gathering-photo evidence snapshot in
      // `ReportsService`. Same cross-module `forFeature` reuse again, rather
      // than importing `EventsModule` for one `findOne`.
      EventPhoto,
    ]),
    // `StorageService` for `ReportPhotoEvidenceController`, which presigns the
    // reported photo for the reviewing moderator. `StorageModule` imports only
    // `forFeature` registrations plus `MediaCropsModule`/`MediaReferencesModule`,
    // so nothing on that side reaches back here and no cycle is created.
    StorageModule,
  ],
  controllers: [ReportsController, ReportPhotoEvidenceController],
  // `ReportFilingThrottlerGuard` is bound with `@UseGuards` on `POST /reports`
  // and listed here as a provider, the same way `StorageModule` registers
  // `UserPresignThrottlerGuard` and `LinkPreviewModule` its own: the guard
  // extends `ThrottlerGuard`, whose `onModuleInit` is what resolves the
  // configured throttlers, so it has to be instantiated by this module's
  // injector.
  providers: [ReportsService, ReportFilingThrottlerGuard],
  // `ModerationModule` imports `ReportsModule` (not its own
  // `TypeOrmModule.forFeature([Report])`) to get `Repository<Report>` for
  // its queue/detail/status-update/audit endpoints — mirrors
  // `UsersModule`'s `exports: [TypeOrmModule, UsersService]` precedent for
  // cross-module entity access.
  exports: [TypeOrmModule, ReportsService],
})
export class ReportsModule {}
