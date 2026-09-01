import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Message } from '../messaging/entities/message.entity';
import { StorageModule } from '../storage/storage.module';
import { Report } from './entities/report.entity';
import { ReportPhotoEvidenceController } from './report-photo-evidence.controller';
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
  providers: [ReportsService],
  // `ModerationModule` imports `ReportsModule` (not its own
  // `TypeOrmModule.forFeature([Report])`) to get `Repository<Report>` for
  // its queue/detail/status-update/audit endpoints — mirrors
  // `UsersModule`'s `exports: [TypeOrmModule, UsersService]` precedent for
  // cross-module entity access.
  exports: [TypeOrmModule, ReportsService],
})
export class ReportsModule {}
