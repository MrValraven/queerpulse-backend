import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { MediaReferencesModule } from '../media-references/media-references.module';
import { Message } from '../messaging/entities/message.entity';
import { User } from '../users/entities/user.entity';
import { FilesController } from './files.controller';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { StorageMaintenanceService } from './storage-maintenance.service';
import { StorageService } from './storage.service';
import { UploadsController } from './uploads.controller';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';

@Module({
  // `User` is registered so `FilesController` can look up the OWNER embedded in
  // a storage key and refuse to serve a suspended/banned member's media to
  // ordinary viewers (its own `forFeature`, mirroring how other modules
  // register their own `User` copy rather than importing `UsersModule`).
  // `Message` is registered the same way so `FilesController` can scope a
  // `message-image` key to its conversation's participants (security review M7)
  // and `StorageMaintenanceService` can tell an orphaned attachment from a
  // referenced one (M10) — a direct repository query, never an import of
  // `MessagingModule`, so no module cycle. `MediaReferencesModule` supplies the
  // `MediaReferenceResolver` the orphan sweep uses to answer "is this key
  // referenced by any image column?". `MediaCropsModule` supplies
  // `MediaCropService` for `POST /uploads/crop`.
  imports: [
    TypeOrmModule.forFeature([User, Message]),
    MediaCropsModule,
    MediaReferencesModule,
  ],
  controllers: [UploadsController, FilesController],
  providers: [
    StorageService,
    StorageMaintenanceService,
    UserPresignThrottlerGuard,
    OptionalJwtAuthGuard,
  ],
  exports: [StorageService],
})
export class StorageModule {}
