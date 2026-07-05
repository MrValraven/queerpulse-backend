import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService, PresignedUpload } from './storage.service';
import { IMAGE_UPLOAD_TYPES } from './upload-content-types';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';

// Presigning mints a short-lived write credential to object storage; rate-limit
// per user (see UserPresignThrottlerGuard) so a single session can't fan out an
// unbounded number of upload slots.
@Controller('uploads')
@UseGuards(UserPresignThrottlerGuard)
@Throttle({ default: { limit: 20, ttl: seconds(60) } })
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  // pending-ok: avatar upload supports editing your own draft profile.
  @Post('avatar')
  avatar(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.presign('avatars', user, dto);
  }

  @Post('work-image')
  workImage(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.presign('work', user, dto);
  }

  // The DTO has already validated contentType against IMAGE_UPLOAD_TYPES, so
  // the lookup is always present; extension and size cap come from that entry.
  private presign(
    prefix: string,
    user: CurrentUserData,
    dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    const spec = IMAGE_UPLOAD_TYPES[dto.contentType];
    const key = `${prefix}/${user.userId}/${randomUUID()}${spec.extension}`;
    return this.storage.createPresignedUpload(
      key,
      dto.contentType,
      spec.maxBytes,
    );
  }
}
