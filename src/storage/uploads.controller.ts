import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { PresignRequestDto } from './dto/presign-request.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService, PresignedUpload } from './storage.service';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Presigning mints a short-lived write credential to object storage; rate-limit
// per user (see UserPresignThrottlerGuard) so a single session can't fan out an
// unbounded number of upload slots. `ActiveMemberGuard` gates all routes so a
// just-suspended/deactivated member can't keep minting upload credentials until
// their access token expires (the global JwtAuthGuard already populates
// `request.user`; every newly onboarded member is `active`, so this only
// excludes suspended/deactivated accounts).
@ApiTags('Uploads')
@ApiCookieAuth()
@Controller('uploads')
@UseGuards(UserPresignThrottlerGuard, ActiveMemberGuard)
@Throttle({ default: { limit: 20, ttl: seconds(60) } })
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  // pending-ok: avatar upload supports editing your own draft profile.
  // Legacy per-surface route — kept working for compatibility, delegates to
  // the same kind-keyed core as POST /uploads/presign.
  @Post('avatar')
  @ApiOperation({ summary: 'Presign an avatar image upload (legacy per-surface route)' })
  @ApiCreatedResponse({ description: 'A short-lived presigned upload credential.' })
  @ApiBadRequestResponse({ description: 'Unsupported content type or oversize upload.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  avatar(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.storage.presignImageUpload({
      kind: 'avatar',
      userId: user.userId,
      contentType: dto.contentType,
    });
  }

  // Legacy per-surface route — kept working for compatibility.
  @Post('work-image')
  @ApiOperation({ summary: 'Presign a work-image upload (legacy per-surface route)' })
  @ApiCreatedResponse({ description: 'A short-lived presigned upload credential.' })
  @ApiBadRequestResponse({ description: 'Unsupported content type or oversize upload.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  workImage(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.storage.presignImageUpload({
      kind: 'work-image',
      userId: user.userId,
      contentType: dto.contentType,
    });
  }

  // Unified presign, keyed by `kind` — the frontend's canonical contract
  // (queerpulse/src/features/members/api/uploads.api.ts). `byteSize` lets the
  // storage service reject an over-cap upload before minting a signature.
  @Post('presign')
  @ApiOperation({ summary: 'Presign an image upload, keyed by upload kind' })
  @ApiCreatedResponse({ description: 'A short-lived presigned upload credential.' })
  @ApiBadRequestResponse({
    description: 'Unsupported upload kind or content type, or oversize upload.',
  })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  presign(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignRequestDto,
  ): Promise<PresignedUpload> {
    return this.storage.presignImageUpload({
      kind: dto.kind,
      userId: user.userId,
      contentType: dto.contentType,
      byteSize: dto.byteSize,
    });
  }
}
