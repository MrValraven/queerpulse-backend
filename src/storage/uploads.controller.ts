import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { PresignRequestDto } from './dto/presign-request.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService, PresignedUpload } from './storage.service';
import { IMAGE_UPLOAD_TYPES } from './upload-content-types';
import { UPLOAD_KIND_SPECS, UploadKind } from './upload-kinds';
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
  // Legacy per-surface route — kept working for compatibility, delegates to
  // the same kind-keyed core as POST /uploads/presign.
  @Post('avatar')
  avatar(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.presignForKind('avatar', user, dto.contentType);
  }

  // Legacy per-surface route — kept working for compatibility.
  @Post('work-image')
  workImage(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.presignForKind('work-image', user, dto.contentType);
  }

  // Unified presign, keyed by `kind` — the frontend's canonical contract
  // (queerpulse/src/features/members/api/uploads.api.ts). `byteSize` lets us
  // reject an over-cap upload before minting a signature.
  @Post('presign')
  presign(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignRequestDto,
  ): Promise<PresignedUpload> {
    return this.presignForKind(dto.kind, user, dto.contentType, dto.byteSize);
  }

  // Shared presign core: resolves the kind's storage-key prefix + byte cap,
  // validates the content type, builds a user-scoped unguessable key, and
  // mints the presigned upload. `byteSize` is optional because the legacy
  // avatar/work-image routes above don't send one — the `/presign` route
  // always does and is the only caller that gets the early over-cap reject.
  private async presignForKind(
    kind: UploadKind,
    user: CurrentUserData,
    contentType: string,
    byteSize?: number,
  ): Promise<PresignedUpload> {
    const typeSpec = IMAGE_UPLOAD_TYPES[contentType];
    if (!typeSpec) {
      throw new BadRequestException(`Unsupported content type: ${contentType}`);
    }
    const kindSpec = UPLOAD_KIND_SPECS[kind];
    if (!kindSpec) {
      throw new BadRequestException(`Unsupported upload kind: ${kind}`);
    }
    if (byteSize !== undefined && byteSize > kindSpec.maxBytes) {
      throw new BadRequestException(
        `File too large for ${kind}: max ${kindSpec.maxBytes} bytes`,
      );
    }
    const key = `${kindSpec.prefix}/${user.userId}/${randomUUID()}${typeSpec.extension}`;
    return this.storage.createPresignedUpload(key, contentType);
  }
}
