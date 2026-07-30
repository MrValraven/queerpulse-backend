import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { UPLOAD_KIND_SPECS, UploadKind } from './upload-kinds';

const CONFIG_VALUES: Record<string, string> = {
  'storage.endpoint': 'https://storage.railway.app',
  'storage.region': 'auto',
  'storage.bucket': 'queerpulse-prod',
  'storage.accessKey': 'test-access-key',
  'storage.secretKey': 'test-secret-key',
};

function buildService(
  overrides: Partial<Record<string, string | undefined>> = {},
): StorageService {
  const values = { ...CONFIG_VALUES, ...overrides };
  const configService = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new StorageService(configService);
}

describe('StorageService', () => {
  describe('createPresignedUpload', () => {
    it('returns the key it was given, not a public URL', async () => {
      const service = buildService();
      const result = await service.createPresignedUpload(
        'avatars/user-1/abc.jpg',
        'image/jpeg',
      );
      expect(result.key).toBe('avatars/user-1/abc.jpg');
      expect(result).not.toHaveProperty('publicUrl');
      expect(result.expiresIn).toBe(300);
    });

    it('signs against the configured Railway endpoint in virtual-hosted style', async () => {
      const service = buildService();
      const result = await service.createPresignedUpload(
        'avatars/user-1/abc.jpg',
        'image/jpeg',
      );
      // Virtual-hosted style puts the bucket in the subdomain, NOT the path.
      expect(result.uploadUrl).toContain(
        'https://queerpulse-prod.storage.railway.app/',
      );
      expect(result.uploadUrl).not.toContain('/queerpulse-prod/avatars');
      expect(result.uploadUrl).toContain('X-Amz-Signature');
    });

    it('never produces an amazonaws.com URL', async () => {
      const service = buildService();
      const result = await service.createPresignedUpload(
        'work/user-1/abc.png',
        'image/png',
      );
      expect(result.uploadUrl).not.toContain('amazonaws.com');
    });

    it('binds the byte count by signing content-length when a size is given', async () => {
      const service = buildService();
      const result = await service.createPresignedUpload(
        'avatars/user-1/abc.jpg',
        'image/jpeg',
        1234,
      );
      // A signed `content-length` header means a client that PUTs more (or
      // fewer) bytes than declared fails the signature — storage enforces the
      // cap, not just the up-front client-declared `byteSize` check.
      const signedHeaders = new URL(result.uploadUrl).searchParams.get(
        'X-Amz-SignedHeaders',
      );
      expect(signedHeaders).toContain('content-length');
    });

    it('omits the content-length binding for the legacy sizeless routes', async () => {
      const service = buildService();
      const result = await service.createPresignedUpload(
        'avatars/user-1/abc.jpg',
        'image/jpeg',
      );
      const signedHeaders = new URL(result.uploadUrl).searchParams.get(
        'X-Amz-SignedHeaders',
      );
      expect(signedHeaders).not.toContain('content-length');
    });

    it('raises when the bucket is not configured', async () => {
      const service = buildService({ 'storage.bucket': undefined });
      await expect(
        service.createPresignedUpload('avatars/user-1/abc.jpg', 'image/jpeg'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  // Upload policy relocated here from UploadsController: content-type whitelist,
  // per-kind byte cap, and the `${prefix}/${userId}/${uuid}${ext}` key layout.
  // These assert the SAME behaviours the controller spec used to.
  describe('presignImageUpload', () => {
    const prefixCases: Array<[UploadKind, string]> = [
      ['avatar', 'avatars'],
      ['work-image', 'work'],
      ['story-cover', 'story-covers'],
      ['gathering-photo', 'gathering-photos'],
      ['group-avatar', 'group-avatars'],
      ['listing-photo', 'listing-photos'],
    ];

    it.each(prefixCases)(
      'namespaces kind "%s" under "%s" as ${prefix}/${userId}/${uuid}${ext}',
      async (kind, prefix) => {
        const service = buildService();
        const result = await service.presignImageUpload({
          kind,
          userId: 'user-1',
          contentType: 'image/png',
          byteSize: 1024,
        });
        // <prefix>/<userId>/<uuid>.png — user-scoped, unguessable, correct ext.
        expect(result.key).toMatch(
          new RegExp(`^${prefix}/user-1/[0-9a-f]{8}-[0-9a-f-]{27}\\.png$`),
        );
      },
    );

    it('derives the object-key extension from the content type (jpeg → .jpg)', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'work-image',
        userId: 'user-1',
        contentType: 'image/jpeg',
      });
      expect(result.key).toMatch(
        /^work\/user-1\/[0-9a-f]{8}-[0-9a-f-]{27}\.jpg$/,
      );
    });

    it('returns the storage key rather than a public URL', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'avatar',
        userId: 'user-1',
        contentType: 'image/jpeg',
        byteSize: 1024,
      });
      expect(result.key).toMatch(/^avatars\/user-1\//);
      expect(result).not.toHaveProperty('publicUrl');
      expect(result.expiresIn).toBe(300);
    });

    it('rejects a disallowed content type with a 400 before signing', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'avatar',
          userId: 'user-1',
          contentType: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown upload kind with a 400 (defensive; the DTO normally gates this)', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'banner' as UploadKind,
          userId: 'user-1',
          contentType: 'image/png',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(Object.keys(UPLOAD_KIND_SPECS) as UploadKind[])(
      'rejects an over-cap byteSize for kind "%s" with a 400',
      async (kind) => {
        const service = buildService();
        const cap = UPLOAD_KIND_SPECS[kind].maxBytes;
        await expect(
          service.presignImageUpload({
            kind,
            userId: 'user-1',
            contentType: 'image/png',
            byteSize: cap + 1,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('accepts a byteSize exactly at the per-kind cap', async () => {
      const service = buildService();
      const cap = UPLOAD_KIND_SPECS['work-image'].maxBytes;
      const result = await service.presignImageUpload({
        kind: 'work-image',
        userId: 'user-1',
        contentType: 'image/png',
        byteSize: cap,
      });
      expect(result.key).toMatch(/^work\/user-1\//);
      expect(result.expiresIn).toBe(300);
    });

    it('pins the declared byteSize by signing content-length', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'avatar',
        userId: 'user-1',
        contentType: 'image/png',
        byteSize: 4096,
      });
      const signedHeaders = new URL(result.uploadUrl).searchParams.get(
        'X-Amz-SignedHeaders',
      );
      expect(signedHeaders).toContain('content-length');
    });

    it('omits the content-length binding for the legacy sizeless routes', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'avatar',
        userId: 'user-1',
        contentType: 'image/png',
      });
      const signedHeaders = new URL(result.uploadUrl).searchParams.get(
        'X-Amz-SignedHeaders',
      );
      expect(signedHeaders).not.toContain('content-length');
    });
  });

  describe('createPresignedDownload', () => {
    it('signs a GET for the given key with the standard expiry', async () => {
      const service = buildService();
      const downloadUrl = await service.createPresignedDownload(
        'gathering-photos/user-1/abc.webp',
      );
      expect(downloadUrl).toContain(
        'https://queerpulse-prod.storage.railway.app/',
      );
      expect(downloadUrl).toContain('gathering-photos/user-1/abc.webp');
      expect(downloadUrl).toContain('X-Amz-Expires=300');
    });

    it('raises when credentials are not configured', async () => {
      const service = buildService({ 'storage.secretKey': undefined });
      await expect(
        service.createPresignedDownload('avatars/user-1/abc.jpg'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
