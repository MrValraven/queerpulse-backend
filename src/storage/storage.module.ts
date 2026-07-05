import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { UploadsController } from './uploads.controller';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';

@Module({
  controllers: [UploadsController],
  providers: [StorageService, UserPresignThrottlerGuard],
  exports: [StorageService],
})
export class StorageModule {}
