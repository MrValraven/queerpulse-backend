import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { isAdminOrHoldsStaffRole } from '../auth/staff-grant-access';
import { codedErrorBody, PLATFORM_ERROR_CODE } from '../common/coded-error';
import { MediaCropService } from '../media-crops/media-crops.service';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { PresignRequestDto } from './dto/presign-request.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { SaveCropDto } from './dto/save-crop.dto';
import {
  isPersonaScopedKey,
  isStudioAudioKey,
  isVjKey,
  storageKeyOwnerId,
} from './storage-key';
import { PersonaImageKeysService } from './persona-image-keys.service';
import {
  DAILY_PRESIGN_BYTE_LIMIT,
  PresignByteQuotaService,
} from './presign-byte-quota.service';
import { StorageService, PresignedUpload } from './storage.service';
import { UPLOAD_ERROR_CODE } from './upload-error-codes';
import { StudioAudioUploadsService } from './studio-audio-uploads.service';
import { UserPresignThrottlerGuard } from './user-presign-throttler.guard';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { studioError } from '../studio/studio.constants';
import { vjError } from '../vj/vj.constants';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

// The refusal a confirm answers for a key the caller could not presign.
const UPLOAD_NOT_YOURS_BODY = codedErrorBody(
  PLATFORM_ERROR_CODE.UPLOAD_NOT_YOURS,
  'Referenced upload does not belong to you',
);

/** A VJ presign request, read off `PresignRequestDto` once its kind is VJ. */
interface VjPresignRequest {
  kind: 'vj_clip' | 'vj_thumbnail' | 'vj_preview';
  contentType: string;
  byteSize: number;
  hasSubprofileId: boolean;
}

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
  constructor(
    private readonly storage: StorageService,
    private readonly mediaCropService: MediaCropService,
    private readonly personaImageKeys: PersonaImageKeysService,
    private readonly studioAudioUploads: StudioAudioUploadsService,
    // Read-only: whether a caller who is not an Admin holds the `vj_operator`
    // grant that opens the VJ upload kinds. Registered in `StorageModule`.
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    // SEC-44: the per-member daily presign byte allowance.
    private readonly presignQuota: PresignByteQuotaService,
  ) {}

  // SEC-44: charges a presign's declared byte size to the caller's daily
  // allowance before the credential is minted, and refunds it when minting
  // fails. An Admin is exempt: platform artwork (stickers, VJ clips) is
  // presigned by admins in bulk, and an admin account is no anonymous abuser.
  //
  // Deliberately not `async`: a refusal `mint` throws synchronously (a bad
  // `subprofileId`) keeps reaching the caller synchronously, as it did
  // before the quota existed.
  //
  // Every positive, finite byte size is charged, whatever the kind. The
  // kind table's `maxBytes` is no ceiling to test against here: a Studio
  // podcast persona presigns `studio_audio` well past that table's cap
  // (`studioAudioMaxBytesForKind`), and leaving such a request uncharged let
  // it skip the allowance. A request `mint` then refuses as too large is
  // refunded below, so the allowance loses nothing for it. A size that is no
  // positive finite number, or one past the whole daily allowance, is handed
  // to `mint` uncharged: no upload kind accepts that many bytes, so `mint`
  // answers with its own "too large" refusal, which names the real cause,
  // and the caller never sees the quota 429 for it.
  private withinDailyQuota(
    user: CurrentUserData,
    byteSize: number,
    mint: () => Promise<PresignedUpload>,
  ): Promise<PresignedUpload> {
    const isChargeableSize =
      Number.isFinite(byteSize) &&
      byteSize > 0 &&
      byteSize <= DAILY_PRESIGN_BYTE_LIMIT;
    if ((user.role as UserRole) === UserRole.Admin || !isChargeableSize) {
      return mint();
    }
    this.presignQuota.charge(user.userId, byteSize);
    const refund = (): void => this.presignQuota.refund(user.userId, byteSize);
    let minting: Promise<PresignedUpload>;
    try {
      minting = mint();
    } catch (error) {
      refund();
      throw error;
    }
    return minting.catch((error: unknown) => {
      refund();
      throw error;
    });
  }

  // pending-ok: avatar upload supports editing your own draft profile.
  // Legacy per-surface route — kept working for compatibility, delegates to
  // the same kind-keyed core as POST /uploads/presign.
  @Post('avatar')
  @ApiOperation({
    summary: 'Presign an avatar image upload (legacy per-surface route)',
  })
  @ApiCreatedResponse({
    description: 'A short-lived presigned upload credential.',
  })
  @ApiBadRequestResponse({
    description: 'Unsupported content type or oversize upload.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  avatar(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.withinDailyQuota(user, dto.byteSize, () =>
      this.storage.presignImageUpload({
        kind: 'avatar',
        userId: user.userId,
        contentType: dto.contentType,
        byteSize: dto.byteSize,
      }),
    );
  }

  // Legacy per-surface route — kept working for compatibility.
  @Post('work-image')
  @ApiOperation({
    summary: 'Presign a work-image upload (legacy per-surface route)',
  })
  @ApiCreatedResponse({
    description: 'A short-lived presigned upload credential.',
  })
  @ApiBadRequestResponse({
    description: 'Unsupported content type or oversize upload.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  workImage(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    return this.withinDailyQuota(user, dto.byteSize, () =>
      this.storage.presignImageUpload({
        kind: 'work-image',
        userId: user.userId,
        contentType: dto.contentType,
        byteSize: dto.byteSize,
      }),
    );
  }

  // Unified presign, keyed by `kind` — the frontend's canonical contract
  // (queerpulse/src/features/members/api/uploads.api.ts). `byteSize` lets the
  // storage service reject an over-cap upload before minting a signature.
  @Post('presign')
  @ApiOperation({ summary: 'Presign an image upload, keyed by upload kind' })
  @ApiCreatedResponse({
    description: 'A short-lived presigned upload credential.',
  })
  @ApiBadRequestResponse({
    description: 'Unsupported upload kind or content type, or oversize upload.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  @ApiForbiddenResponse({
    description:
      'A sticker upload by a caller who is not an admin, or a VJ upload (vj_clip, vj_thumbnail and vj_preview) by a caller with no VJ access: neither the Admin role nor the vj_operator staff grant (code VJ_UPLOAD_NOT_ADMIN).',
  })
  @ApiTooManyRequestsResponse({
    description:
      'The caller has presigned their daily byte allowance (code UPLOAD_DAILY_QUOTA_REACHED).',
  })
  presign(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PresignRequestDto,
  ): Promise<PresignedUpload> {
    // VJ media is platform artwork presigned by staff in bulk (clips up to
    // 100 MB), so it is left out of the member allowance, as an Admin is.
    if (
      dto.kind === 'vj_clip' ||
      dto.kind === 'vj_thumbnail' ||
      dto.kind === 'vj_preview'
    ) {
      return this.presignForKind(user, dto);
    }
    return this.withinDailyQuota(user, dto.byteSize, () =>
      this.presignForKind(user, dto),
    );
  }

  /** The kind-keyed presign behind `POST /uploads/presign`. */
  private presignForKind(
    user: CurrentUserData,
    dto: PresignRequestDto,
  ): Promise<PresignedUpload> {
    // Every other kind is member media. A sticker is platform artwork served
    // publicly to every member of every conversation, so only an admin may
    // mint a write credential under the `stickers/` prefix. The spec table in
    // `upload-kinds.ts` has no role field, which is why this one kind's rule
    // lives here rather than there.
    if (dto.kind === 'sticker' && (user.role as UserRole) !== UserRole.Admin) {
      throw new ForbiddenException('Only an admin may upload a sticker');
    }
    // VJ media is platform artwork under keys that name nobody, open to an
    // Admin and to a holder of the `vj_operator` grant (the rule
    // `RolesOrStaffGuard` applies to `admin/vj`). An Admin is answered on the
    // role alone; anyone else waits on one grant lookup.
    if (
      dto.kind === 'vj_clip' ||
      dto.kind === 'vj_thumbnail' ||
      dto.kind === 'vj_preview'
    ) {
      const vjRequest: VjPresignRequest = {
        kind: dto.kind,
        contentType: dto.contentType,
        byteSize: dto.byteSize,
        hasSubprofileId: dto.subprofileId !== undefined,
      };
      if ((user.role as UserRole) !== UserRole.Admin) {
        return this.presignVjUploadForGrantHolder(user, vjRequest);
      }
      return this.presignVjUpload(vjRequest);
    }
    // Studio v1: a track's audio is presigned for a persona under a key that
    // names nobody. `StudioAudioUploadsService` checks the Studio grant, the
    // caller's membership of the persona and its kind, and records which
    // persona the key belongs to.
    if (dto.kind === 'studio_audio') {
      if (!dto.subprofileId) {
        throw new BadRequestException(
          'subprofileId is required for studio_audio uploads',
        );
      }
      return this.studioAudioUploads.presign(user.userId, {
        subprofileId: dto.subprofileId,
        contentType: dto.contentType,
        byteSize: dto.byteSize,
      });
    }
    if (dto.subprofileId !== undefined) {
      throw new BadRequestException(
        'subprofileId is accepted for studio_audio uploads only',
      );
    }
    return this.storage.presignImageUpload({
      kind: dto.kind,
      userId: user.userId,
      contentType: dto.contentType,
      byteSize: dto.byteSize,
    });
  }

  /** A VJ presign for a caller who is not an Admin: refused with
   *  `VJ_UPLOAD_NOT_ADMIN` (no VJ access) unless they hold `vj_operator`. */
  private async presignVjUploadForGrantHolder(
    user: CurrentUserData,
    vjRequest: VjPresignRequest,
  ): Promise<PresignedUpload> {
    const isVjOperator = await isAdminOrHoldsStaffRole(this.staffRoles, user, [
      'vj_operator',
    ]);
    if (!isVjOperator) {
      throw vjError('VJ_UPLOAD_NOT_ADMIN');
    }
    return this.presignVjUpload(vjRequest);
  }

  /** The VJ presign once access is settled: VJ keys carry no persona. */
  private presignVjUpload(
    vjRequest: VjPresignRequest,
  ): Promise<PresignedUpload> {
    if (vjRequest.hasSubprofileId) {
      throw new BadRequestException(
        'subprofileId is accepted for studio_audio uploads only',
      );
    }
    return this.storage.presignVjUpload({
      kind: vjRequest.kind,
      contentType: vjRequest.contentType,
      byteSize: vjRequest.byteSize,
    });
  }

  // SEC-43: checks an upload's stored bytes once its PUT has landed. The
  // presigned PUT goes straight to the bucket, so the server cannot strip
  // metadata; this reads the object's leading bytes and refuses, with a code
  // the client maps to its own copy, a JPEG whose EXIF still carries a GPS
  // block (UPLOAD_HAS_LOCATION_DATA) or bytes that do not match the declared
  // type (UPLOAD_CONTENT_MISMATCH). The serve route refuses both kinds of
  // object on its own as well, so a client that skips this call gains
  // nothing.
  //
  // Who may confirm a key is who may presign it: a member key's uploader; for
  // a Studio audio key, any member who passes the Studio presign checks for
  // the persona its registry row names (`confirmUploadRefusal`: an ended
  // Studio grant answers `studio_access_required` and a persona kind that
  // cannot upload `studio_persona_kind_not_allowed`, as the presign does);
  // for a VJ key, an Admin or a `vj_operator` grant holder, as the VJ
  // presign allows. Anyone else meets 403 UPLOAD_NOT_YOURS.
  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Check an uploaded object before attaching it' })
  @ApiNoContentResponse({ description: 'The upload is servable.' })
  @ApiForbiddenResponse({
    description:
      'The key does not belong to you, or names a Studio or VJ upload you may not presign (code UPLOAD_NOT_YOURS), or your Studio access ended (code studio_access_required) or the persona kind cannot upload audio (code studio_persona_kind_not_allowed).',
  })
  @ApiNotFoundResponse({
    description: 'No object was stored under the key (code UPLOAD_NOT_FOUND).',
  })
  @ApiBadRequestResponse({
    description:
      'The key names no member, Studio audio or VJ upload (code UPLOAD_KEY_NOT_CONFIRMABLE).',
  })
  @ApiServiceUnavailableResponse({
    description:
      'The storage check could not run just now (code UPLOAD_CHECK_UNAVAILABLE).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The JPEG still carries GPS location data (code UPLOAD_HAS_LOCATION_DATA), or the bytes do not match the declared type: an image, document, MP3, M4A, MP4 or WebM signature (code UPLOAD_CONTENT_MISMATCH).',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async confirm(
    @CurrentUser() user: CurrentUserData,
    @Body() body: ConfirmUploadDto,
  ): Promise<void> {
    await this.assertMayConfirm(user, body.key);
    const verdict = await this.storage.inspectStoredObject(body.key);
    if (verdict === 'location_metadata') {
      throw new UnprocessableEntityException(
        codedErrorBody(
          UPLOAD_ERROR_CODE.UPLOAD_HAS_LOCATION_DATA,
          'This photo still carries the location it was taken at',
        ),
      );
    }
    if (verdict === 'mismatch') {
      throw new UnprocessableEntityException(
        codedErrorBody(
          UPLOAD_ERROR_CODE.UPLOAD_CONTENT_MISMATCH,
          'The uploaded file does not match its declared type',
        ),
      );
    }
    if (verdict === 'missing') {
      throw new NotFoundException(
        codedErrorBody(
          UPLOAD_ERROR_CODE.UPLOAD_NOT_FOUND,
          'No uploaded file was found under this key',
        ),
      );
    }
    if (verdict === 'indeterminate') {
      throw new ServiceUnavailableException(
        codedErrorBody(
          UPLOAD_ERROR_CODE.UPLOAD_CHECK_UNAVAILABLE,
          'The uploaded file could not be checked just now',
        ),
      );
    }
  }

  /** Refuses a confirm the caller may not send: 400 for a key that names no
   *  upload this route checks, 403 for a key the caller could not presign. */
  private async assertMayConfirm(
    user: CurrentUserData,
    key: string,
  ): Promise<void> {
    if (isStudioAudioKey(key)) {
      const refusal = await this.studioAudioUploads.confirmUploadRefusal(
        user.userId,
        key,
      );
      if (refusal === 'upload_not_yours') {
        throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
      }
      if (refusal !== null) {
        throw studioError(refusal);
      }
      return;
    }
    if (isVjKey(key)) {
      const hasVjAccess = await isAdminOrHoldsStaffRole(this.staffRoles, user, [
        'vj_operator',
      ]);
      if (!hasVjAccess) {
        throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
      }
      return;
    }
    const ownerId = storageKeyOwnerId(key);
    if (ownerId === null) {
      // A malformed key, or one that names nobody (persona and other
      // scoped keys): there is no upload here to confirm.
      throw new BadRequestException(
        codedErrorBody(
          UPLOAD_ERROR_CODE.UPLOAD_KEY_NOT_CONFIRMABLE,
          'This key names no member upload to confirm',
        ),
      );
    }
    if (ownerId !== user.userId) {
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }
  }

  // Persists the reframe crop chosen for an already-uploaded image, keyed by
  // storage key. `storageKeyOwnerId` decodes the owner embedded in the key
  // itself (see storage-key.ts) so this can't be spoofed by passing someone
  // else's key. A persona-scoped key is checked against its persona's
  // members instead.
  @Post('crop')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Save (or clear) the crop for an uploaded image' })
  @ApiNoContentResponse({ description: 'Crop saved.' })
  @ApiBadRequestResponse({
    description: 'Invalid key or crop payload.',
  })
  @ApiForbiddenResponse({ description: 'The key does not belong to you.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async saveCrop(
    @CurrentUser() user: CurrentUserData,
    @Body() body: SaveCropDto,
  ): Promise<void> {
    // T17: a persona-scoped key names no uploader. It belongs to the persona
    // `persona_storage_keys` records for it, so any member of that persona
    // may reframe it. The crop row keeps the caller as its owner.
    if (isPersonaScopedKey(body.key)) {
      const isMember = await this.personaImageKeys.isMemberOfKeyPersona(
        body.key,
        user.userId,
      );
      if (!isMember) {
        throw new ForbiddenException();
      }
      await this.mediaCropService.upsert(body.key, user.userId, body.crop);
      return;
    }
    const ownerId = storageKeyOwnerId(body.key);
    if (ownerId === null || ownerId !== user.userId) {
      throw new ForbiddenException();
    }
    await this.mediaCropService.upsert(body.key, ownerId, body.crop);
  }
}
