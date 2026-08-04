import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { FilesController } from './files.controller';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { StorageService } from './storage.service';
import { UploadsController } from './uploads.controller';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';

@Module({
  // `User` is registered so `FilesController` can look up the OWNER embedded in
  // a storage key and refuse to serve a suspended/banned member's media to
  // ordinary viewers (its own `forFeature`, mirroring how other modules
  // register their own `User` copy rather than importing `UsersModule`).
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UploadsController, FilesController],
  providers: [StorageService, UserPresignThrottlerGuard, OptionalJwtAuthGuard],
  exports: [StorageService],
})
export class StorageModule {}
