import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { StorageService } from './storage.service';

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

    it('raises when the bucket is not configured', async () => {
      const service = buildService({ 'storage.bucket': undefined });
      await expect(
        service.createPresignedUpload('avatars/user-1/abc.jpg', 'image/jpeg'),
      ).rejects.toThrow(InternalServerErrorException);
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
