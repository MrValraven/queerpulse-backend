import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { StorageService } from './storage.service';
import { UploadsController } from './uploads.controller';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';

@Module({
  controllers: [UploadsController, FilesController],
  providers: [StorageService, UserPresignThrottlerGuard, OptionalJwtAuthGuard],
  exports: [StorageService],
})
export class StorageModule {}
