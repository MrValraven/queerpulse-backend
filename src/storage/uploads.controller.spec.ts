import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { PresignRequestDto } from './dto/presign-request.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService, PresignedUpload } from './storage.service';
import { ALLOWED_IMAGE_TYPES } from './upload-content-types';
import { UPLOAD_KIND_SPECS, UploadKind } from './upload-kinds';
import { UploadsController } from './uploads.controller';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'm@example.com',
  status: 'active',
  role: 'member',
};

const PRESIGNED: PresignedUpload = {
  uploadUrl: 'https://s3.example.com/bucket/key?X-Amz-Signature=abc',
  publicUrl: 'https://cdn.example.com/key',
  expiresIn: 300,
};

describe('UploadsController', () => {
  let controller: UploadsController;
  let storage: { createPresignedUpload: jest.Mock };

  const lastCall = (): [string, string] =>
    storage.createPresignedUpload.mock.calls[0] as [string, string];

  beforeEach(() => {
    storage = {
      createPresignedUpload: jest.fn().mockResolvedValue(PRESIGNED),
    };
    controller = new UploadsController(storage as unknown as StorageService);
  });

  describe('legacy per-surface routes (kept working)', () => {
    it('builds an avatar key namespaced to the user with the mapped extension', async () => {
      const result = await controller.avatar(user, {
        contentType: 'image/png',
      });
      const [key, contentType] = lastCall();
      // avatars/<userId>/<uuid>.png — user-scoped, unguessable, correct extension.
      expect(key).toMatch(/^avatars\/user-1\/[0-9a-f]{8}-[0-9a-f-]{27}\.png$/);
      expect(contentType).toBe('image/png');
      expect(result).toBe(PRESIGNED);
    });

    it('namespaces work-image keys under work/ with the mapped extension', async () => {
      await controller.workImage(user, { contentType: 'image/jpeg' });
      const [key] = lastCall();
      expect(key).toMatch(/^work\/user-1\/[0-9a-f]{8}-[0-9a-f-]{27}\.jpg$/);
    });

    it('rejects a non-image content type on the avatar route', async () => {
      await expect(
        controller.avatar(user, { contentType: 'application/pdf' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.createPresignedUpload).not.toHaveBeenCalled();
    });
  });

  describe('POST /uploads/presign — kind → prefix + cap', () => {
    const prefixCases: Array<[UploadKind, string]> = [
      ['avatar', 'avatars'],
      ['work-image', 'work'],
      ['story-cover', 'story-covers'],
      ['gathering-photo', 'gathering-photos'],
    ];

    it.each(prefixCases)(
      'maps kind "%s" to the "%s" key prefix',
      async (kind, prefix) => {
        await controller.presign(user, {
          kind,
          contentType: 'image/png',
          byteSize: 1024,
        });
        const [key] = lastCall();
        expect(key.startsWith(`${prefix}/user-1/`)).toBe(true);
      },
    );

    it('returns a response containing uploadUrl + publicUrl', async () => {
      const result = await controller.presign(user, {
        kind: 'avatar',
        contentType: 'image/png',
        byteSize: 1024,
      });
      expect(result).toEqual(
        expect.objectContaining({
          uploadUrl: PRESIGNED.uploadUrl,
          publicUrl: PRESIGNED.publicUrl,
        }),
      );
    });

    it.each(Object.keys(UPLOAD_KIND_SPECS) as UploadKind[])(
      'rejects an over-cap byteSize for kind "%s" with a 400',
      async (kind) => {
        const cap = UPLOAD_KIND_SPECS[kind].maxBytes;
        await expect(
          controller.presign(user, {
            kind,
            contentType: 'image/png',
            byteSize: cap + 1,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(storage.createPresignedUpload).not.toHaveBeenCalled();
      },
    );

    it('accepts a byteSize exactly at the per-kind cap', async () => {
      const cap = UPLOAD_KIND_SPECS['work-image'].maxBytes;
      await expect(
        controller.presign(user, {
          kind: 'work-image',
          contentType: 'image/png',
          byteSize: cap,
        }),
      ).resolves.toBe(PRESIGNED);
    });

    it('rejects a disallowed content type with a 400', async () => {
      await expect(
        controller.presign(user, {
          kind: 'avatar',
          // Bypasses the DTO's own IsIn gate to exercise the controller's
          // own defence-in-depth check.
          contentType: 'application/pdf',
          byteSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.createPresignedUpload).not.toHaveBeenCalled();
    });
  });

  describe('content-type gate (PresignUploadDto — legacy routes)', () => {
    it('accepts every whitelisted image type', async () => {
      for (const contentType of ALLOWED_IMAGE_TYPES) {
        const dto = plainToInstance(PresignUploadDto, { contentType });
        expect(await validate(dto)).toHaveLength(0);
      }
    });

    it('rejects a non-image content type', async () => {
      const dto = plainToInstance(PresignUploadDto, {
        contentType: 'application/pdf',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isIn');
    });

    it('rejects a video content type (the gate defends the presign)', async () => {
      const dto = plainToInstance(PresignUploadDto, {
        contentType: 'video/mp4',
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rejects a missing content type', async () => {
      const dto = plainToInstance(PresignUploadDto, {});
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
