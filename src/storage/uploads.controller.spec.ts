import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { StorageService, PresignedUpload } from './storage.service';
import { IMAGE_UPLOAD_TYPES } from './upload-content-types';
import { UploadsController } from './uploads.controller';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'm@example.com',
  status: 'active',
  role: 'member',
};

const PRESIGNED: PresignedUpload = {
  url: 'https://s3.example.com/bucket',
  fields: { key: 'k', 'Content-Type': 'image/png' },
  fileUrl: 'https://cdn.example.com/k',
};

describe('UploadsController', () => {
  let controller: UploadsController;
  let storage: { createPresignedUpload: jest.Mock };

  const lastCall = (): [string, string, number] =>
    storage.createPresignedUpload.mock.calls[0] as [string, string, number];

  beforeEach(() => {
    storage = {
      createPresignedUpload: jest.fn().mockResolvedValue(PRESIGNED),
    };
    controller = new UploadsController(
      storage as unknown as StorageService,
    );
  });

  it('builds an avatar key namespaced to the user with the mapped extension', async () => {
    const result = await controller.avatar(user, { contentType: 'image/png' });
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

  it('passes the per-type size cap through to the presigner', async () => {
    await controller.avatar(user, { contentType: 'image/gif' });
    const [, contentType, maxBytes] = lastCall();
    expect(contentType).toBe('image/gif');
    expect(maxBytes).toBe(IMAGE_UPLOAD_TYPES['image/gif'].maxBytes);
    expect(maxBytes).toBe(8 * 1024 * 1024);
  });

  it('caps images at 5 MB by default', async () => {
    await controller.avatar(user, { contentType: 'image/webp' });
    const [, , maxBytes] = lastCall();
    expect(maxBytes).toBe(5 * 1024 * 1024);
  });

  describe('content-type gate (PresignUploadDto)', () => {
    it('accepts every whitelisted image type', async () => {
      for (const contentType of Object.keys(IMAGE_UPLOAD_TYPES)) {
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
});
