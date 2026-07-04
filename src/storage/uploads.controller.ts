import { Body, Controller, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService } from './storage.service';

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

@Controller('uploads')
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  // pending-ok: avatar upload supports editing your own draft profile.
  @Post('avatar')
  avatar(@CurrentUser() user: CurrentUserData, @Body() dto: PresignUploadDto) {
    const key = `avatars/${user.userId}/${randomUUID()}${EXT[dto.contentType]}`;
    return this.storage.createPresignedUpload(key, dto.contentType);
  }

  @Post('work-image')
  workImage(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ) {
    const key = `work/${user.userId}/${randomUUID()}${EXT[dto.contentType]}`;
    return this.storage.createPresignedUpload(key, dto.contentType);
  }
}
