import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaCrop } from './entities/media-crop.entity';
import { MediaCropService } from './media-crops.service';

@Module({
  imports: [TypeOrmModule.forFeature([MediaCrop])],
  providers: [MediaCropService],
  exports: [MediaCropService],
})
export class MediaCropsModule {}
