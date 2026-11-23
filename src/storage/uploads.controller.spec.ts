import { BadRequestException, HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PresignRequestDto } from './dto/presign-request.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { PersonaImageKeysService } from './persona-image-keys.service';
import {
  DAILY_PRESIGN_BYTE_LIMIT,
  PresignByteQuotaService,
} from './presign-byte-quota.service';
import { StorageService, PresignedUpload } from './storage.service';
import { ALLOWED_IMAGE_TYPES } from './upload-content-types';
import { UPLOAD_KIND_SPECS } from './upload-kinds';
import { StudioAudioUploadsService } from './studio-audio-uploads.service';
import { UploadsController } from './uploads.controller';
import { allowsVjKeys } from './shared-upload-handlers';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'm@example.com',
  status: 'active',
  role: 'member',
};

const PRESIGNED: PresignedUpload = {
  uploadUrl:
    'https://queerpulse-prod.storage.railway.app/avatars/key?X-Amz-Signature=abc',
  key: 'avatars/user-1/abc.jpg',
  expiresIn: 300,
};

const STUDIO_PRESIGNED: PresignedUpload = {
  uploadUrl:
    'https://queerpulse-prod.storage.railway.app/studio-audio/key?X-Amz-Signature=abc',
  key: 'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3',
  expiresIn: 300,
};
const PERSONA_ID = '7a000000-0000-4000-8000-000000000001';

const VJ_PRESIGNED: PresignedUpload = {
  uploadUrl:
    'https://queerpulse-prod.storage.railway.app/vj-clips/key?X-Amz-Signature=abc',
  key: 'vj-clips/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp4',
  expiresIn: 300,
};

describe('UploadsController', () => {
  let controller: UploadsController;
  let storage: { presignImageUpload: jest.Mock; presignVjUpload: jest.Mock };
  let studioAudioUploads: {
    presign: jest.Mock;
    confirmUploadRefusal: jest.Mock;
  };
  let mediaCropService: { upsert: jest.Mock };
  let personaImageKeys: { isMemberOfKeyPersona: jest.Mock };
  // The staff grants each user id holds, read by the VJ kinds.
  let grantsByUserId: Map<string, string[]>;
  let staffRoles: { exists: jest.Mock };
  let presignQuota: PresignByteQuotaService;

  beforeEach(() => {
    storage = {
      presignImageUpload: jest.fn().mockResolvedValue(PRESIGNED),
      presignVjUpload: jest.fn().mockResolvedValue(VJ_PRESIGNED),
    };
    studioAudioUploads = {
      presign: jest.fn().mockResolvedValue(STUDIO_PRESIGNED),
      confirmUploadRefusal: jest.fn().mockResolvedValue('upload_not_yours'),
    };
    mediaCropService = {
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    personaImageKeys = {
      isMemberOfKeyPersona: jest.fn().mockResolvedValue(false),
    };
    // Default: nobody holds a staff grant.
    grantsByUserId = new Map();
    staffRoles = {
      exists: jest.fn(
        (options: { where: { userId: string; role: string }[] }) =>
          Promise.resolve(
            options.where.some((condition) =>
              (grantsByUserId.get(condition.userId) ?? []).includes(
                condition.role,
              ),
            ),
          ),
      ),
    };
    presignQuota = new PresignByteQuotaService();
    controller = new UploadsController(
      storage as unknown as StorageService,
      mediaCropService as unknown as MediaCropService,
      personaImageKeys as unknown as PersonaImageKeysService,
      studioAudioUploads as unknown as StudioAudioUploadsService,
      staffRoles as unknown as Repository<UserStaffRole>,
      presignQuota,
    );
  });

  // SEC-43: `POST /uploads/confirm` names each refusal with its own code.
  describe('confirm', () => {
    const OWN_KEY = `work/${'11111111-2222-4333-8444-555555555555'}/66666666-7777-4888-8999-000000000000.jpg`;
    const confirmer: CurrentUserData = {
      ...user,
      userId: '11111111-2222-4333-8444-555555555555',
    };
    let inspectStoredObject: jest.Mock;

    beforeEach(() => {
      inspectStoredObject = jest.fn().mockResolvedValue('valid');
      (
        storage as unknown as { inspectStoredObject: jest.Mock }
      ).inspectStoredObject = inspectStoredObject;
    });

    async function codeOf(key: string): Promise<unknown> {
      try {
        await controller.confirm(confirmer, { key });
        return undefined;
      } catch (error) {
        const body = (error as HttpException).getResponse() as {
          code?: unknown;
        };
        return body.code;
      }
    }

    it('passes a servable upload', async () => {
      await expect(codeOf(OWN_KEY)).resolves.toBeUndefined();
    });

    it.each([
      ['location_metadata', 'UPLOAD_HAS_LOCATION_DATA'],
      ['mismatch', 'UPLOAD_CONTENT_MISMATCH'],
      ['missing', 'UPLOAD_NOT_FOUND'],
      ['indeterminate', 'UPLOAD_CHECK_UNAVAILABLE'],
    ])('answers a %s verdict with %s', async (verdict, code) => {
      inspectStoredObject.mockResolvedValue(verdict);
      await expect(codeOf(OWN_KEY)).resolves.toBe(code);
    });

    it('refuses a key that names no uploader before reading storage', async () => {
      await expect(codeOf('not-a-key')).resolves.toBe(
        'UPLOAD_KEY_NOT_CONFIRMABLE',
      );
      expect(inspectStoredObject).not.toHaveBeenCalled();
    });

    it("refuses somebody else's key with the ownership code", async () => {
      await expect(
        codeOf(
          'work/99999999-8888-4777-8666-555555555555/66666666-7777-4888-8999-000000000000.jpg',
        ),
      ).resolves.toBe('UPLOAD_NOT_YOURS');
    });

    // Open item A: Studio audio keys name nobody, so the registry row and the
    // Studio presign checks decide who may confirm one.
    describe('a Studio audio key', () => {
      const STUDIO_KEY = STUDIO_PRESIGNED.key;

      it('passes a caller who may presign for the registered persona', async () => {
        studioAudioUploads.confirmUploadRefusal.mockResolvedValue(null);
        await expect(codeOf(STUDIO_KEY)).resolves.toBeUndefined();
        expect(studioAudioUploads.confirmUploadRefusal).toHaveBeenCalledWith(
          confirmer.userId,
          STUDIO_KEY,
        );
        expect(inspectStoredObject).toHaveBeenCalledWith(STUDIO_KEY);
      });

      it.each([
        ['upload_not_yours', 'UPLOAD_NOT_YOURS'],
        ['studio_access_required', 'studio_access_required'],
        ['studio_persona_kind_not_allowed', 'studio_persona_kind_not_allowed'],
      ])(
        'answers a %s refusal with a 403 coded %s before reading storage',
        async (refusal, code) => {
          studioAudioUploads.confirmUploadRefusal.mockResolvedValue(refusal);
          let caught: unknown;
          try {
            await controller.confirm(confirmer, { key: STUDIO_KEY });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(HttpException);
          expect((caught as HttpException).getStatus()).toBe(403);
          expect((caught as HttpException).getResponse()).toEqual(
            expect.objectContaining({ code }),
          );
          expect(inspectStoredObject).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['mismatch', 'UPLOAD_CONTENT_MISMATCH'],
        ['missing', 'UPLOAD_NOT_FOUND'],
      ])('answers a %s verdict with %s', async (verdict, code) => {
        studioAudioUploads.confirmUploadRefusal.mockResolvedValue(null);
        inspectStoredObject.mockResolvedValue(verdict);
        await expect(codeOf(STUDIO_KEY)).resolves.toBe(code);
      });
    });

    // Open item A: VJ keys belong to the shared library, open to whoever the
    // VJ presign admits (the Admin role or the `vj_operator` grant).
    describe('a VJ key', () => {
      const VJ_KEYS = [
        VJ_PRESIGNED.key,
        'vj-thumbnails/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.webp',
        'vj-previews/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.webm',
      ];

      it('lets the ownership interceptor pass a VJ key to confirm', () => {
        expect(allowsVjKeys('UploadsController', 'confirm')).toBe(true);
      });

      it.each(VJ_KEYS)(
        'refuses a caller with no VJ access for %s',
        async (key) => {
          await expect(codeOf(key)).resolves.toBe('UPLOAD_NOT_YOURS');
          expect(inspectStoredObject).not.toHaveBeenCalled();
        },
      );

      it.each(VJ_KEYS)(
        'passes a vj_operator grant holder for %s',
        async (key) => {
          grantsByUserId.set(confirmer.userId, ['vj_operator']);
          await expect(codeOf(key)).resolves.toBeUndefined();
          expect(inspectStoredObject).toHaveBeenCalledWith(key);
        },
      );

      it('passes an admin without a grant lookup', async () => {
        const admin: CurrentUserData = { ...confirmer, role: 'admin' };
        await expect(
          controller.confirm(admin, { key: VJ_PRESIGNED.key }),
        ).resolves.toBeUndefined();
        expect(staffRoles.exists).not.toHaveBeenCalled();
      });

      it('names a clip whose bytes are no MP4 with the mismatch code', async () => {
        grantsByUserId.set(confirmer.userId, ['vj_operator']);
        inspectStoredObject.mockResolvedValue('mismatch');
        await expect(codeOf(VJ_PRESIGNED.key)).resolves.toBe(
          'UPLOAD_CONTENT_MISMATCH',
        );
      });
    });
  });

  // SEC-44: a member's presigns are charged to a daily byte allowance.
  describe('daily presign byte allowance', () => {
    it('refuses a presign past the allowance with the coded 429', async () => {
      presignQuota.charge(user.userId, DAILY_PRESIGN_BYTE_LIMIT);
      let refusal: unknown;
      try {
        await controller.avatar(user, {
          contentType: 'image/png',
          byteSize: 2048,
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(HttpException);
      expect((refusal as HttpException).getStatus()).toBe(429);
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
    });

    it('refunds an over-cap request the presign refuses as too large', async () => {
      presignQuota.charge(
        user.userId,
        DAILY_PRESIGN_BYTE_LIMIT - 100 * 1024 * 1024,
      );
      // 100 MB is past the avatar cap: the request is charged, the presign
      // refuses it by size, and the refund leaves the allowance whole.
      storage.presignImageUpload.mockRejectedValueOnce(
        new BadRequestException('too large'),
      );
      await expect(
        controller.avatar(user, {
          contentType: 'image/png',
          byteSize: 100 * 1024 * 1024,
        }),
      ).rejects.toThrow('too large');
      await expect(
        controller.avatar(user, {
          contentType: 'image/png',
          byteSize: 100 * 1024 * 1024,
        }),
      ).resolves.toBe(PRESIGNED);
    });

    it('hands a presign past the whole allowance to the size refusal, uncharged', async () => {
      // No kind accepts more bytes than a day's allowance, so the request
      // gets the presign's "too large" refusal and never the quota 429.
      storage.presignImageUpload.mockRejectedValueOnce(
        new BadRequestException('too large'),
      );
      let refusal: unknown;
      try {
        await controller.avatar(user, {
          contentType: 'image/png',
          byteSize: DAILY_PRESIGN_BYTE_LIMIT + 1,
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect(storage.presignImageUpload).toHaveBeenCalledTimes(1);
      // Nothing was charged: a full allowance is still there to spend.
      await expect(
        controller.avatar(user, {
          contentType: 'image/png',
          byteSize: DAILY_PRESIGN_BYTE_LIMIT,
        }),
      ).resolves.toBe(PRESIGNED);
    });

    it('charges a studio_audio presign above the kind table cap', async () => {
      // A podcast persona presigns audio past `UPLOAD_KIND_SPECS`'s
      // studio_audio cap; the bytes still count against the allowance.
      const podcastBytes = UPLOAD_KIND_SPECS.studio_audio.maxBytes + 1024;
      presignQuota.charge(user.userId, DAILY_PRESIGN_BYTE_LIMIT - podcastBytes);
      await controller.presign(user, {
        kind: 'studio_audio',
        contentType: 'audio/mpeg',
        byteSize: podcastBytes,
        subprofileId: PERSONA_ID,
      });
      let refusal: unknown;
      try {
        await controller.avatar(user, {
          contentType: 'image/png',
          byteSize: 1024,
        });
      } catch (error) {
        refusal = error;
      }
      expect((refusal as HttpException).getStatus()).toBe(429);
    });

    it('refunds the charge of a presign that fails', async () => {
      storage.presignImageUpload.mockRejectedValueOnce(new Error('bucket'));
      presignQuota.charge(user.userId, DAILY_PRESIGN_BYTE_LIMIT - 2048);
      await expect(
        controller.avatar(user, { contentType: 'image/png', byteSize: 2048 }),
      ).rejects.toThrow('bucket');
      await expect(
        controller.avatar(user, { contentType: 'image/png', byteSize: 2048 }),
      ).resolves.toBe(PRESIGNED);
    });
  });

  // The controller is a thin pass-through: it forwards the authenticated
  // caller's `userId` plus the validated DTO fields to
  // `StorageService.presignImageUpload` and returns its result verbatim. The
  // upload policy it used to own — content-type whitelist, per-kind byte cap,
  // and the `${prefix}/${userId}/${uuid}${ext}` key layout — now lives in the
  // service and is exercised in storage.service.spec.ts.
  describe('pass-through to StorageService.presignImageUpload', () => {
    it('avatar route forwards kind "avatar" with the caller, content type, and byteSize', async () => {
      const result = await controller.avatar(user, {
        contentType: 'image/png',
        byteSize: 2048,
      });
      expect(storage.presignImageUpload).toHaveBeenCalledWith({
        kind: 'avatar',
        userId: 'user-1',
        contentType: 'image/png',
        byteSize: 2048,
      });
      expect(result).toBe(PRESIGNED);
    });

    it('work-image route forwards kind "work-image" and byteSize', async () => {
      const result = await controller.workImage(user, {
        contentType: 'image/jpeg',
        byteSize: 2048,
      });
      expect(storage.presignImageUpload).toHaveBeenCalledWith({
        kind: 'work-image',
        userId: 'user-1',
        contentType: 'image/jpeg',
        byteSize: 2048,
      });
      expect(result).toBe(PRESIGNED);
    });

    it('unified presign route forwards kind, content type and byteSize', async () => {
      const result = await controller.presign(user, {
        kind: 'story-cover',
        contentType: 'image/webp',
        byteSize: 4096,
      });
      expect(storage.presignImageUpload).toHaveBeenCalledWith({
        kind: 'story-cover',
        userId: 'user-1',
        contentType: 'image/webp',
        byteSize: 4096,
      });
      expect(result).toBe(PRESIGNED);
    });
  });

  describe('content-type gate (PresignUploadDto — legacy routes)', () => {
    it('accepts every whitelisted image type', async () => {
      for (const contentType of ALLOWED_IMAGE_TYPES) {
        const dto = plainToInstance(PresignUploadDto, {
          contentType,
          byteSize: 1024,
        });
        expect(await validate(dto)).toHaveLength(0);
      }
    });

    it('rejects a non-image content type', async () => {
      const dto = plainToInstance(PresignUploadDto, {
        contentType: 'application/pdf',
        byteSize: 1024,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.constraints).toHaveProperty('isIn');
    });

    it('rejects a video content type (the gate defends the presign)', async () => {
      const dto = plainToInstance(PresignUploadDto, {
        contentType: 'video/mp4',
        byteSize: 1024,
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a missing content type', async () => {
      const dto = plainToInstance(PresignUploadDto, { byteSize: 1024 });
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  // Mirrors the byteSize gate already covered for PresignRequestDto below —
  // this is the actual fix for the unbounded-upload bug: the legacy routes
  // now reject an oversize/missing declared size the same way `/presign` does.
  describe('byteSize gate (PresignUploadDto — legacy routes)', () => {
    it('rejects a non-integer byteSize', async () => {
      const dto = plainToInstance(PresignUploadDto, {
        contentType: 'image/png',
        byteSize: 1.5,
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a zero or negative byteSize', async () => {
      const zero = plainToInstance(PresignUploadDto, {
        contentType: 'image/png',
        byteSize: 0,
      });
      expect(await validate(zero)).not.toHaveLength(0);

      const negative = plainToInstance(PresignUploadDto, {
        contentType: 'image/png',
        byteSize: -10,
      });
      expect(await validate(negative)).not.toHaveLength(0);
    });

    it('rejects a missing byteSize', async () => {
      const dto = plainToInstance(PresignUploadDto, {
        contentType: 'image/png',
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  describe('presign body gate (PresignRequestDto)', () => {
    it('accepts a valid body for every kind', async () => {
      for (const kind of Object.keys(UPLOAD_KIND_SPECS).filter(
        (kindName) => kindName !== 'studio_audio',
      )) {
        const dto = plainToInstance(PresignRequestDto, {
          kind,
          contentType: 'image/png',
          byteSize: 1024,
        });
        expect(await validate(dto)).toHaveLength(0);
      }
    });

    it('rejects an unknown kind', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'banner',
        contentType: 'image/png',
        byteSize: 1024,
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'kind')).toBe(true);
    });

    // The DTO admits the union of every kind's content types (an avatar's PDF
    // is refused later by the per-kind table in `StorageService`), so the body
    // gate refuses a type that no upload kind accepts.
    it('rejects a content type no upload kind accepts', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'avatar',
        contentType: 'text/html',
        byteSize: 1024,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'contentType')).toBe(true);
    });

    it('rejects a non-integer byteSize', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'avatar',
        contentType: 'image/png',
        byteSize: 1.5,
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a zero or negative byteSize', async () => {
      const zero = plainToInstance(PresignRequestDto, {
        kind: 'avatar',
        contentType: 'image/png',
        byteSize: 0,
      });
      expect(await validate(zero)).not.toHaveLength(0);

      const negative = plainToInstance(PresignRequestDto, {
        kind: 'avatar',
        contentType: 'image/png',
        byteSize: -10,
      });
      expect(await validate(negative)).not.toHaveLength(0);
    });

    it('rejects a missing byteSize', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'avatar',
        contentType: 'image/png',
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('requires a persona id on a studio_audio body', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'studio_audio',
        contentType: 'audio/mpeg',
        byteSize: 1024,
      });
      const errors = await validate(dto);
      expect(errors.some((error) => error.property === 'subprofileId')).toBe(
        true,
      );
    });

    it('accepts a studio_audio body with a persona id and an audio type', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'studio_audio',
        contentType: 'audio/mp4',
        byteSize: 1024,
        subprofileId: PERSONA_ID,
      });
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe('Studio audio presign', () => {
    it('hands a studio_audio request to the Studio presign with the caller and persona', async () => {
      const result = await controller.presign(user, {
        kind: 'studio_audio',
        contentType: 'audio/mpeg',
        byteSize: 4096,
        subprofileId: PERSONA_ID,
      });
      expect(studioAudioUploads.presign).toHaveBeenCalledWith('user-1', {
        subprofileId: PERSONA_ID,
        contentType: 'audio/mpeg',
        byteSize: 4096,
      });
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
      expect(result).toBe(STUDIO_PRESIGNED);
    });

    it('refuses a persona id on any other kind', () => {
      expect(() =>
        controller.presign(user, {
          kind: 'avatar',
          contentType: 'image/png',
          byteSize: 4096,
          subprofileId: PERSONA_ID,
        }),
      ).toThrow(BadRequestException);
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
    });
  });

  // VJ media is open to an admin and to a holder of the vj_operator grant,
  // with a coded refusal the frontend can name.
  describe('VJ presign', () => {
    const moderator: CurrentUserData = { ...user, role: 'moderator' };
    const admin: CurrentUserData = { ...user, role: 'admin' };

    /** The refusal a presign rejects with, or undefined when it resolves. */
    async function refusalOf(
      presign: () => Promise<PresignedUpload>,
    ): Promise<unknown> {
      try {
        await presign();
        return undefined;
      } catch (error) {
        return error;
      }
    }

    it('refuses a VJ presign for a moderator with VJ_UPLOAD_NOT_ADMIN', async () => {
      for (const caller of [moderator, user]) {
        for (const request of [
          { kind: 'vj_clip' as const, contentType: 'video/mp4' },
          { kind: 'vj_thumbnail' as const, contentType: 'image/webp' },
        ]) {
          const refusal = await refusalOf(() =>
            controller.presign(caller, { ...request, byteSize: 4096 }),
          );
          expect(refusal).toBeInstanceOf(HttpException);
          expect((refusal as HttpException).getStatus()).toBe(403);
          expect((refusal as HttpException).getResponse()).toEqual(
            expect.objectContaining({ code: 'VJ_UPLOAD_NOT_ADMIN' }),
          );
        }
      }
      expect(storage.presignVjUpload).not.toHaveBeenCalled();
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
    });

    it('passes an admin VJ presign to presignVjUpload', async () => {
      const result = await controller.presign(admin, {
        kind: 'vj_clip',
        contentType: 'video/webm',
        byteSize: 4096,
      });
      expect(storage.presignVjUpload).toHaveBeenCalledWith({
        kind: 'vj_clip',
        contentType: 'video/webm',
        byteSize: 4096,
      });
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
      expect(studioAudioUploads.presign).not.toHaveBeenCalled();
      expect(result).toBe(VJ_PRESIGNED);

      await controller.presign(admin, {
        kind: 'vj_thumbnail',
        contentType: 'image/webp',
        byteSize: 2048,
      });
      expect(storage.presignVjUpload).toHaveBeenLastCalledWith({
        kind: 'vj_thumbnail',
        contentType: 'image/webp',
        byteSize: 2048,
      });
    });

    it('refuses a preview presign for a moderator with VJ_UPLOAD_NOT_ADMIN', async () => {
      for (const caller of [moderator, user]) {
        for (const contentType of ['video/webm', 'video/mp4']) {
          const refusal = await refusalOf(() =>
            controller.presign(caller, {
              kind: 'vj_preview',
              contentType,
              byteSize: 4096,
            }),
          );
          expect(refusal).toBeInstanceOf(HttpException);
          expect((refusal as HttpException).getStatus()).toBe(403);
          expect((refusal as HttpException).getResponse()).toEqual(
            expect.objectContaining({ code: 'VJ_UPLOAD_NOT_ADMIN' }),
          );
        }
      }
      expect(storage.presignVjUpload).not.toHaveBeenCalled();
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
    });

    it('passes an admin preview presign to presignVjUpload', async () => {
      const result = await controller.presign(admin, {
        kind: 'vj_preview',
        contentType: 'video/webm',
        byteSize: 4096,
      });
      expect(storage.presignVjUpload).toHaveBeenCalledWith({
        kind: 'vj_preview',
        contentType: 'video/webm',
        byteSize: 4096,
      });
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
      expect(studioAudioUploads.presign).not.toHaveBeenCalled();
      expect(result).toBe(VJ_PRESIGNED);
    });

    it('passes a vj_operator holder to presignVjUpload for every VJ kind', async () => {
      grantsByUserId.set(user.userId, ['vj_operator']);
      for (const request of [
        { kind: 'vj_clip' as const, contentType: 'video/mp4' },
        { kind: 'vj_thumbnail' as const, contentType: 'image/webp' },
        { kind: 'vj_preview' as const, contentType: 'video/webm' },
      ]) {
        const result = await controller.presign(user, {
          ...request,
          byteSize: 4096,
        });
        expect(storage.presignVjUpload).toHaveBeenLastCalledWith({
          ...request,
          byteSize: 4096,
        });
        expect(result).toBe(VJ_PRESIGNED);
      }
      expect(staffRoles.exists).toHaveBeenCalledWith({
        where: [{ userId: user.userId, role: 'vj_operator' }],
      });
      expect(storage.presignImageUpload).not.toHaveBeenCalled();
    });

    it('refuses a holder of an unrelated grant with VJ_UPLOAD_NOT_ADMIN', async () => {
      grantsByUserId.set(user.userId, ['music_manager_producer']);
      const refusal = await refusalOf(() =>
        controller.presign(user, {
          kind: 'vj_clip',
          contentType: 'video/mp4',
          byteSize: 4096,
        }),
      );
      expect(refusal).toBeInstanceOf(HttpException);
      expect((refusal as HttpException).getStatus()).toBe(403);
      expect((refusal as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'VJ_UPLOAD_NOT_ADMIN' }),
      );
      expect(storage.presignVjUpload).not.toHaveBeenCalled();
    });

    it('refuses a subprofileId on a vj_operator presign', async () => {
      grantsByUserId.set(user.userId, ['vj_operator']);
      await expect(
        controller.presign(user, {
          kind: 'vj_clip',
          contentType: 'video/mp4',
          byteSize: 4096,
          subprofileId: PERSONA_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.presignVjUpload).not.toHaveBeenCalled();
    });

    it('refuses a subprofileId on a VJ presign', () => {
      expect(() =>
        controller.presign(admin, {
          kind: 'vj_clip',
          contentType: 'video/mp4',
          byteSize: 4096,
          subprofileId: PERSONA_ID,
        }),
      ).toThrow(BadRequestException);
      expect(storage.presignVjUpload).not.toHaveBeenCalled();
    });
  });

  // T17: a persona-scoped key names no uploader, so the crop route checks the
  // members of the persona it belongs to.
  describe('saveCrop on a persona-scoped key', () => {
    const personaKey =
      'persona/0b6f2a4c-1d2e-4f30-9a8b-7c6d5e4f3a2b/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d.jpg';
    const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5, aspect: '1:1' };

    it('saves the crop for a member of the persona, owned by the caller', async () => {
      personaImageKeys.isMemberOfKeyPersona.mockResolvedValue(true);

      await controller.saveCrop(user, { key: personaKey, crop });

      expect(personaImageKeys.isMemberOfKeyPersona).toHaveBeenCalledWith(
        personaKey,
        'user-1',
      );
      expect(mediaCropService.upsert).toHaveBeenCalledWith(
        personaKey,
        'user-1',
        crop,
      );
    });

    it('refuses a caller who is not a member of the persona', async () => {
      personaImageKeys.isMemberOfKeyPersona.mockResolvedValue(false);

      await expect(
        controller.saveCrop(user, { key: personaKey, crop }),
      ).rejects.toThrow('Forbidden');
      expect(mediaCropService.upsert).not.toHaveBeenCalled();
    });

    it('keeps the uploader rule for a user-scoped key', async () => {
      await expect(
        controller.saveCrop(user, {
          key: 'avatars/0b6f2a4c-1d2e-4f30-9a8b-7c6d5e4f3a2b/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d.jpg',
          crop,
        }),
      ).rejects.toThrow('Forbidden');
      expect(personaImageKeys.isMemberOfKeyPersona).not.toHaveBeenCalled();
    });
  });
});
