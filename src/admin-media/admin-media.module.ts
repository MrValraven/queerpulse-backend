import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { StorageModule } from '../storage/storage.module';
import { AdminMediaController } from './admin-media.controller';
import { AdminMediaService } from './admin-media.service';

@Module({
  // `Profile` for uploader resolution; `StorageModule` exports `StorageService`
  // for the bucket listing / head / presign calls.
  imports: [TypeOrmModule.forFeature([Profile]), StorageModule],
  controllers: [AdminMediaController],
  providers: [AdminMediaService],
})
export class AdminMediaModule {}
