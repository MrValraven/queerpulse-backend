import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PresignRequestDto } from './dto/presign-request.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService, PresignedUpload } from './storage.service';
import { ALLOWED_IMAGE_TYPES } from './upload-content-types';
import { UPLOAD_KIND_SPECS } from './upload-kinds';
import { UploadsController } from './uploads.controller';

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

describe('UploadsController', () => {
  let controller: UploadsController;
  let storage: { presignImageUpload: jest.Mock };
  let mediaCropService: { upsert: jest.Mock };

  beforeEach(() => {
    storage = {
      presignImageUpload: jest.fn().mockResolvedValue(PRESIGNED),
    };
    mediaCropService = {
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    controller = new UploadsController(
      storage as unknown as StorageService,
      mediaCropService as unknown as MediaCropService,
    );
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
      for (const kind of Object.keys(UPLOAD_KIND_SPECS)) {
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

    it('rejects a disallowed content type', async () => {
      const dto = plainToInstance(PresignRequestDto, {
        kind: 'avatar',
        contentType: 'application/pdf',
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
  });
});
