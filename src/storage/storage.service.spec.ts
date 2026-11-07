import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageService, studioStreamExpirySeconds } from './storage.service';
import {
  STUDIO_AUDIO_KEY_PATTERN,
  VJ_CLIP_KEY_PATTERN,
  VJ_PREVIEW_KEY_PATTERN,
  VJ_THUMBNAIL_KEY_PATTERN,
  isStudioLandingScopedKey,
} from './storage-key';
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
  // Persona feed import: the server's own write path, used to keep a copy of
  // podcast art instead of hotlinking it.
  describe('putServerObject', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const PNG = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 0,
    ]);
    let send: jest.SpiedFunction<S3Client['send']>;

    beforeEach(() => {
      send = jest
        .spyOn(S3Client.prototype, 'send')
        .mockResolvedValue({} as never);
    });

    afterEach(() => {
      send.mockRestore();
    });

    it('writes the bytes under a fresh key of the kind, owned by the user', async () => {
      const key = await buildService().putServerObject(
        'work-image',
        OWNER,
        PNG,
        'image/png',
      );
      expect(key).toMatch(new RegExp(`^work/${OWNER}/[0-9a-f-]{36}\\.png$`));
      const [command] = send.mock.calls[0] as unknown as [PutObjectCommand];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toEqual(
        expect.objectContaining({
          Bucket: 'queerpulse-prod',
          Key: key,
          ContentType: 'image/png',
          ContentLength: PNG.byteLength,
          Body: PNG,
        }),
      );
    });

    it('refuses bytes whose magic does not match the declared type', async () => {
      await expect(
        buildService().putServerObject('work-image', OWNER, PNG, 'image/jpeg'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a type the kind does not accept, and an over-cap body', async () => {
      await expect(
        buildService().putServerObject(
          'work-image',
          OWNER,
          new TextEncoder().encode('%PDF-1.7'),
          'application/pdf',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const tooBig = new Uint8Array(
        UPLOAD_KIND_SPECS['work-image'].maxBytes + 1,
      );
      tooBig.set(PNG);
      await expect(
        buildService().putServerObject(
          'work-image',
          OWNER,
          tooBig,
          'image/png',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });
  });

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

    it('omits the content-length binding when no size is given (defensive path — every current route always sends one)', async () => {
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

    it('omits the content-length binding when no size is given (defensive path — every current route always sends one)', async () => {
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

  // PRD-226: `message-document` is validated against the DOCUMENT whitelist,
  // not the image one — the opposite of every other kind above.
  describe('presignImageUpload — message-document (PRD-226)', () => {
    it('accepts a PDF and namespaces the key under message-documents/', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'message-document',
        userId: 'user-1',
        contentType: 'application/pdf',
        byteSize: 1024,
      });
      expect(result.key).toMatch(
        /^message-documents\/user-1\/[0-9a-f]{8}-[0-9a-f-]{27}\.pdf$/,
      );
    });

    it.each([
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ])('accepts %s', async (contentType) => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'message-document',
        userId: 'user-1',
        contentType,
        byteSize: 1024,
      });
      expect(result.key).toMatch(/^message-documents\/user-1\//);
    });

    it('rejects an IMAGE content type for a document kind (the tables do not cross over)', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'message-document',
          userId: 'user-1',
          contentType: 'image/png',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a DOCUMENT content type for an image kind (the tables do not cross over)', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'avatar',
          userId: 'user-1',
          contentType: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an over-cap byteSize (20 MB) with a 400', async () => {
      const service = buildService();
      const cap = UPLOAD_KIND_SPECS['message-document'].maxBytes;
      await expect(
        service.presignImageUpload({
          kind: 'message-document',
          userId: 'user-1',
          contentType: 'application/pdf',
          byteSize: cap + 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('presignImageUpload - listing-menu (mixed image/document)', () => {
    it('accepts a PDF for the listing-menu kind under listing-menus/', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'listing-menu',
        userId: 'user-1',
        contentType: 'application/pdf',
        byteSize: 1024,
      });
      expect(result.key).toMatch(
        /^listing-menus\/user-1\/[0-9a-f]{8}-[0-9a-f-]{27}\.pdf$/,
      );
    });

    it('accepts an image for the listing-menu kind', async () => {
      const service = buildService();
      const result = await service.presignImageUpload({
        kind: 'listing-menu',
        userId: 'user-1',
        contentType: 'image/webp',
        byteSize: 1024,
      });
      expect(result.key).toMatch(/^listing-menus\/user-1\/.+\.webp$/);
    });

    it('rejects a spreadsheet for the listing-menu kind', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'listing-menu',
          userId: 'user-1',
          contentType: 'text/csv',
          byteSize: 1024,
        }),
      ).rejects.toThrow('Unsupported content type');
    });

    it('rejects a listing-menu file over 10 MB', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'listing-menu',
          userId: 'user-1',
          contentType: 'application/pdf',
          byteSize: 10 * 1024 * 1024 + 1,
        }),
      ).rejects.toThrow('File too large');
    });

    it('still refuses a PDF for an image-only kind', async () => {
      const service = buildService();
      await expect(
        service.presignImageUpload({
          kind: 'listing-photo',
          userId: 'user-1',
          contentType: 'application/pdf',
          byteSize: 1024,
        }),
      ).rejects.toThrow('Unsupported content type');
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

  describe('Studio audio', () => {
    const STUDIO_KEY =
      'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';

    it('mints a key with two random segments and the extension of its type', async () => {
      const service = buildService();
      const mp3 = await service.presignStudioAudioUpload({
        contentType: 'audio/mpeg',
        byteSize: 1024,
      });
      const m4a = await service.presignStudioAudioUpload({
        contentType: 'audio/mp4',
        byteSize: 1024,
      });
      expect(mp3.key).toMatch(STUDIO_AUDIO_KEY_PATTERN);
      expect(mp3.key.endsWith('.mp3')).toBe(true);
      expect(m4a.key.endsWith('.m4a')).toBe(true);
      expect(mp3.key).not.toContain('user-1');
    });

    it('accepts a file exactly at 50 MB and answers one byte more with a 413', async () => {
      const service = buildService();
      await expect(
        service.presignStudioAudioUpload({
          contentType: 'audio/mpeg',
          byteSize: UPLOAD_KIND_SPECS.studio_audio.maxBytes,
        }),
      ).resolves.toEqual(expect.objectContaining({ expiresIn: 300 }));
      await expect(
        service.presignStudioAudioUpload({
          contentType: 'audio/mpeg',
          byteSize: UPLOAD_KIND_SPECS.studio_audio.maxBytes + 1,
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    // Studio artist kinds: the caller passes the podcast cap.
    it('takes a file up to the cap the caller passes and answers one byte more with a 413', async () => {
      const service = buildService();
      await expect(
        service.presignStudioAudioUpload({
          contentType: 'audio/mp4',
          byteSize: 262144000,
          maxBytes: 262144000,
        }),
      ).resolves.toEqual(expect.objectContaining({ expiresIn: 300 }));
      await expect(
        service.presignStudioAudioUpload({
          contentType: 'audio/mp4',
          byteSize: 262144001,
          maxBytes: 262144000,
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('refuses an image type for a track', async () => {
      await expect(
        buildService().presignStudioAudioUpload({
          contentType: 'image/png',
          byteSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps Studio audio away from the user-scoped presign', async () => {
      await expect(
        buildService().presignImageUpload({
          kind: 'studio_audio',
          userId: 'user-1',
          contentType: 'audio/mpeg',
          byteSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('signs a stream URL that expires in 900 seconds when the duration is unknown', async () => {
      const startedAt = Date.now();
      const stream = await buildService().createPresignedAudioStream(
        STUDIO_KEY,
        'audio/mpeg',
        null,
      );
      const signedUrl = new URL(stream.url);
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(signedUrl.searchParams.get('response-content-type')).toBe(
        'audio/mpeg',
      );
      expect(new Date(stream.expiresAt).getTime()).toBeGreaterThanOrEqual(
        startedAt + 900_000,
      );
    });

    it('signs a stream URL that expires in 900 seconds when called with two arguments', async () => {
      const stream = await buildService().createPresignedAudioStream(
        STUDIO_KEY,
        'audio/mpeg',
      );
      const signedUrl = new URL(stream.url);
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(signedUrl.searchParams.get('response-cache-control')).toBe(
        'private, max-age=900',
      );
    });

    it('signs an hour-long mix for its length plus ten minutes, cache lifetime included', async () => {
      const startedAt = Date.now();
      const stream = await buildService().createPresignedAudioStream(
        STUDIO_KEY,
        'audio/mp4',
        3600,
      );
      const signedUrl = new URL(stream.url);
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('4200');
      expect(signedUrl.searchParams.get('response-cache-control')).toBe(
        'private, max-age=4200',
      );
      const expiresAtMilliseconds = new Date(stream.expiresAt).getTime();
      expect(expiresAtMilliseconds).toBeGreaterThanOrEqual(
        startedAt + 4_200_000,
      );
      expect(expiresAtMilliseconds).toBeLessThanOrEqual(Date.now() + 4_200_000);
    });

    it('signs a 900-second attachment download named after the artist and the track, with the stored extension', async () => {
      const download = await buildService().createPresignedAudioDownload(
        STUDIO_KEY,
        'audio/mpeg',
        'Night Shift - Opening',
      );
      const signedUrl = new URL(download.url);
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(signedUrl.searchParams.get('response-content-type')).toBe(
        'audio/mpeg',
      );
      expect(signedUrl.searchParams.get('response-cache-control')).toBe(
        'private, no-store',
      );
      expect(signedUrl.searchParams.get('response-content-disposition')).toBe(
        `attachment; filename="Night Shift - Opening.mp3"; filename*=UTF-8''Night%20Shift%20-%20Opening.mp3`,
      );
      expect(download.fileName).toBe('Night Shift - Opening.mp3');
    });

    it('strips slashes, quotes and control characters from the name', async () => {
      const download = await buildService().createPresignedAudioDownload(
        STUDIO_KEY,
        'audio/mpeg',
        'A/B "C"\n - D',
      );
      expect(download.fileName).toBe('A_B _C_ - D.mp3');
    });

    it('refuses a key outside Studio audio', async () => {
      await expect(
        buildService().createPresignedAudioDownload(
          'avatars/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg',
          'audio/mpeg',
          'Night Shift - Opening',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('signs a kept copy for download', async () => {
      const download = await buildService().createPresignedAudioDownload(
        'studio-kept-audio/66666666-7777-4888-9999-000000000000.mp3',
        'audio/mpeg',
        'A - B',
      );
      expect(download.fileName).toBe('A - B.mp3');
      expect(new URL(download.url).pathname).toContain('studio-kept-audio');
    });

    describe('copyStudioAudioForKeeping', () => {
      let send: jest.SpiedFunction<S3Client['send']>;

      beforeEach(() => {
        send = jest
          .spyOn(S3Client.prototype, 'send')
          .mockResolvedValue({} as never);
      });

      afterEach(() => {
        send.mockRestore();
      });

      it('copies a Studio audio object to a fresh kept key with the content type extension', async () => {
        const keptKey = await buildService().copyStudioAudioForKeeping(
          STUDIO_KEY,
          'audio/mp4',
        );
        expect(keptKey).toMatch(/^studio-kept-audio\/[0-9a-f-]{36}\.m4a$/);
        const [command] = send.mock.calls[0] as unknown as [CopyObjectCommand];
        expect(command).toBeInstanceOf(CopyObjectCommand);
        expect(command.input).toEqual({
          Bucket: 'queerpulse-prod',
          CopySource: `queerpulse-prod/${STUDIO_KEY}`,
          Key: keptKey,
        });
      });

      it('refuses to copy a key outside Studio audio or an unknown content type', async () => {
        await expect(
          buildService().copyStudioAudioForKeeping(
            'avatars/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg',
            'audio/mpeg',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          buildService().copyStudioAudioForKeeping(STUDIO_KEY, 'audio/wav'),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          buildService().copyStudioAudioForKeeping(
            'studio-kept-audio/66666666-7777-4888-9999-000000000000.mp3',
            'audio/mpeg',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(send).not.toHaveBeenCalled();
      });
    });

    it('refuses to sign a stream for a key outside the Studio shape', async () => {
      await expect(
        buildService().createPresignedAudioStream(
          'avatars/user-1/abc.jpg',
          'audio/mpeg',
          200,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('copyObjectToStudioLandingScope', () => {
    const STAFF_UPLOAD_KEY =
      'work-image/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg';
    let send: jest.SpiedFunction<S3Client['send']>;

    beforeEach(() => {
      send = jest
        .spyOn(S3Client.prototype, 'send')
        .mockResolvedValue({} as never);
    });

    afterEach(() => {
      send.mockRestore();
    });

    it('copies a staff upload under a fresh landing-scoped key', async () => {
      const key =
        await buildService().copyObjectToStudioLandingScope(STAFF_UPLOAD_KEY);
      expect(isStudioLandingScopedKey(key)).toBe(true);
      expect(key.endsWith('.jpg')).toBe(true);
      const [command] = send.mock.calls[0] as unknown as [CopyObjectCommand];
      expect(command).toBeInstanceOf(CopyObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'queerpulse-prod',
        CopySource: `queerpulse-prod/${STAFF_UPLOAD_KEY}`,
        Key: key,
      });
    });

    it('refuses to copy a key that names nobody', async () => {
      await expect(
        buildService().copyObjectToStudioLandingScope(
          'persona/66666666-7777-4888-9999-000000000000/66666666-7777-4888-9999-000000000001.jpg',
        ),
      ).rejects.toThrow(new BadRequestException('Invalid storage key'));
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('VJ uploads', () => {
    const VJ_CLIP_KEY =
      'vj-clips/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp4';
    const VJ_THUMBNAIL_KEY =
      'vj-thumbnails/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.webp';

    // The refusal a VJ presign throws, read as status plus body.
    async function vjRefusalOf(
      pending: Promise<unknown>,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const error: unknown = await pending.then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      return {
        status: httpError.getStatus(),
        body: httpError.getResponse() as Record<string, unknown>,
      };
    }

    it('mints VJ keys with two random segments', async () => {
      const service = buildService();
      const createPresignedUpload = jest.spyOn(
        service,
        'createPresignedUpload',
      );
      const firstClip = await service.presignVjUpload({
        kind: 'vj_clip',
        contentType: 'video/webm',
        byteSize: 10,
      });
      const secondClip = await service.presignVjUpload({
        kind: 'vj_clip',
        contentType: 'video/webm',
        byteSize: 10,
      });
      expect(firstClip.key).toMatch(VJ_CLIP_KEY_PATTERN);
      expect(firstClip.key.endsWith('.webm')).toBe(true);
      // The method takes no user id, so the middle segment is minted fresh
      // on every call and names nobody.
      const [, firstMiddleSegment] = firstClip.key.split('/');
      const [, secondMiddleSegment] = secondClip.key.split('/');
      expect(firstMiddleSegment).not.toBe(secondMiddleSegment);
      expect(firstClip.key).not.toContain('user-1');
      expect(createPresignedUpload).toHaveBeenCalledWith(
        firstClip.key,
        'video/webm',
        10,
      );
      expect(
        new URL(firstClip.uploadUrl).searchParams.get('X-Amz-SignedHeaders'),
      ).toContain('content-length');
      expect(firstClip.expiresIn).toBe(300);

      const thumbnail = await service.presignVjUpload({
        kind: 'vj_thumbnail',
        contentType: 'image/webp',
        byteSize: 2048,
      });
      expect(thumbnail.key).toMatch(VJ_THUMBNAIL_KEY_PATTERN);
    });

    it('answers the VJ codes for a wrong type or an oversize file', async () => {
      const service = buildService();
      const pngAsClip = await vjRefusalOf(
        service.presignVjUpload({
          kind: 'vj_clip',
          contentType: 'image/png',
          byteSize: 10,
        }),
      );
      expect(pngAsClip.status).toBe(400);
      expect(pngAsClip.body).toEqual(
        expect.objectContaining({
          code: 'VJ_UPLOAD_TYPE_UNSUPPORTED',
          kind: 'vj_clip',
        }),
      );

      const videoAsThumbnail = await vjRefusalOf(
        service.presignVjUpload({
          kind: 'vj_thumbnail',
          contentType: 'video/mp4',
          byteSize: 10,
        }),
      );
      expect(videoAsThumbnail.status).toBe(400);
      expect(videoAsThumbnail.body).toEqual(
        expect.objectContaining({
          code: 'VJ_UPLOAD_TYPE_UNSUPPORTED',
          kind: 'vj_thumbnail',
        }),
      );

      const oversizeClip = await vjRefusalOf(
        service.presignVjUpload({
          kind: 'vj_clip',
          contentType: 'video/mp4',
          byteSize: 104857601,
        }),
      );
      expect(oversizeClip.status).toBe(413);
      expect(oversizeClip.body).toEqual(
        expect.objectContaining({
          code: 'VJ_UPLOAD_TOO_LARGE',
          kind: 'vj_clip',
          maxBytes: 104857600,
        }),
      );

      const oversizeThumbnail = await vjRefusalOf(
        service.presignVjUpload({
          kind: 'vj_thumbnail',
          contentType: 'image/webp',
          byteSize: 262145,
        }),
      );
      expect(oversizeThumbnail.status).toBe(413);
      expect(oversizeThumbnail.body).toEqual(
        expect.objectContaining({
          code: 'VJ_UPLOAD_TOO_LARGE',
          kind: 'vj_thumbnail',
          maxBytes: 262144,
        }),
      );

      await expect(
        service.presignVjUpload({
          kind: 'vj_clip',
          contentType: 'video/mp4',
          byteSize: 104857600,
        }),
      ).resolves.toEqual(expect.objectContaining({ expiresIn: 300 }));
    });

    it('refuses VJ kinds on the image presign', async () => {
      await expect(
        buildService().presignImageUpload({
          kind: 'vj_clip',
          userId: 'user-1',
          contentType: 'video/mp4',
          byteSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        buildService().presignImageUpload({
          kind: 'vj_thumbnail',
          userId: 'user-1',
          contentType: 'image/webp',
          byteSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('mints preview keys with two random segments', async () => {
      const service = buildService();
      const createPresignedUpload = jest.spyOn(
        service,
        'createPresignedUpload',
      );
      const webmPreview = await service.presignVjUpload({
        kind: 'vj_preview',
        contentType: 'video/webm',
        byteSize: 4096,
      });
      const mp4Preview = await service.presignVjUpload({
        kind: 'vj_preview',
        contentType: 'video/mp4',
        byteSize: 4096,
      });
      expect(webmPreview.key).toMatch(VJ_PREVIEW_KEY_PATTERN);
      expect(webmPreview.key.startsWith('vj-previews/')).toBe(true);
      expect(webmPreview.key.endsWith('.webm')).toBe(true);
      expect(mp4Preview.key).toMatch(VJ_PREVIEW_KEY_PATTERN);
      expect(mp4Preview.key.endsWith('.mp4')).toBe(true);
      // Both segments are minted fresh on every call, so a preview key names
      // nobody.
      const [, webmMiddleSegment, webmLastSegment] = webmPreview.key.split('/');
      const [, mp4MiddleSegment, mp4LastSegment] = mp4Preview.key.split('/');
      expect(webmMiddleSegment).not.toBe(mp4MiddleSegment);
      expect(webmLastSegment).not.toBe(mp4LastSegment);
      expect(createPresignedUpload).toHaveBeenCalledWith(
        webmPreview.key,
        'video/webm',
        4096,
      );
      expect(webmPreview.expiresIn).toBe(300);
    });

    it('answers the VJ codes for a preview of the wrong type or size', async () => {
      const service = buildService();
      const gifPreview = await vjRefusalOf(
        service.presignVjUpload({
          kind: 'vj_preview',
          contentType: 'image/gif',
          byteSize: 10,
        }),
      );
      expect(gifPreview.status).toBe(400);
      expect(gifPreview.body).toEqual(
        expect.objectContaining({
          code: 'VJ_UPLOAD_TYPE_UNSUPPORTED',
          kind: 'vj_preview',
        }),
      );

      const oversizePreview = await vjRefusalOf(
        service.presignVjUpload({
          kind: 'vj_preview',
          contentType: 'video/webm',
          byteSize: 524289,
        }),
      );
      expect(oversizePreview.status).toBe(413);
      expect(oversizePreview.body).toEqual(
        expect.objectContaining({
          code: 'VJ_UPLOAD_TOO_LARGE',
          kind: 'vj_preview',
          maxBytes: 524288,
        }),
      );

      await expect(
        service.presignVjUpload({
          kind: 'vj_preview',
          contentType: 'video/mp4',
          byteSize: 524288,
        }),
      ).resolves.toEqual(expect.objectContaining({ expiresIn: 300 }));
    });

    it('refuses vj_preview on the image presign', async () => {
      await expect(
        buildService().presignImageUpload({
          kind: 'vj_preview',
          userId: 'user-1',
          contentType: 'video/webm',
          byteSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('leaves preview keys out of a user object sweep', async () => {
      const userId = '99999999-8888-4777-8666-555555555555';
      const service = buildService();
      const previewKey = (
        await service.presignVjUpload({
          kind: 'vj_preview',
          contentType: 'video/webm',
          byteSize: 4096,
        })
      ).key;
      const send = jest
        .spyOn(S3Client.prototype, 'send')
        .mockResolvedValue({ Contents: [], IsTruncated: false } as never);
      try {
        await expect(service.deleteUserObjects(userId)).resolves.toBe(0);
        const listedPrefixes = send.mock.calls
          .map(([command]) => command as unknown)
          .filter(
            (command): command is ListObjectsV2Command =>
              command instanceof ListObjectsV2Command,
          )
          .map((command) => command.input.Prefix);
        // The sweep lists the preview prefix under the member's id, and no
        // preview key ever sits there: its middle segment is a fresh uuid.
        expect(listedPrefixes).toContain(`vj-previews/${userId}/`);
        expect(previewKey.startsWith(`vj-previews/${userId}/`)).toBe(false);
        expect(previewKey).not.toContain(userId);
        // Only list calls went out; nothing was deleted.
        expect(
          send.mock.calls.every(
            ([command]) => command instanceof ListObjectsV2Command,
          ),
        ).toBe(true);
      } finally {
        send.mockRestore();
      }
    });

    it('signs a 900 second clip GET with the stored type', async () => {
      const startedAt = Date.now();
      const download = await buildService().createPresignedVjClipDownload(
        VJ_CLIP_KEY,
        'video/mp4',
      );
      const signedUrl = new URL(download.url);
      expect(signedUrl.pathname.endsWith(VJ_CLIP_KEY)).toBe(true);
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(signedUrl.searchParams.get('response-content-type')).toBe(
        'video/mp4',
      );
      expect(signedUrl.searchParams.get('response-content-disposition')).toBe(
        'inline',
      );
      expect(signedUrl.searchParams.get('response-cache-control')).toBe(
        'private, max-age=900',
      );
      const expiresAtMilliseconds = new Date(download.expiresAt).getTime();
      expect(expiresAtMilliseconds).toBeGreaterThanOrEqual(startedAt + 900_000);
      expect(expiresAtMilliseconds).toBeLessThanOrEqual(Date.now() + 900_000);

      await expect(
        buildService().createPresignedVjClipDownload(
          VJ_THUMBNAIL_KEY,
          'video/mp4',
        ),
      ).rejects.toThrow(new BadRequestException('Invalid storage key'));
    });

    describe('readObjectPrefixBytes', () => {
      let send: jest.SpiedFunction<S3Client['send']>;

      afterEach(() => {
        send.mockRestore();
      });

      it('reads the first sixteen bytes of an object', async () => {
        const prefixBytes = Uint8Array.from([
          0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0,
          0, 0,
        ]);
        send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({
          Body: { transformToByteArray: () => Promise.resolve(prefixBytes) },
        } as never);
        await expect(
          buildService().readObjectPrefixBytes(VJ_CLIP_KEY),
        ).resolves.toEqual(prefixBytes);
        const [command] = send.mock.calls[0] as unknown as [GetObjectCommand];
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toEqual({
          Bucket: 'queerpulse-prod',
          Key: VJ_CLIP_KEY,
          Range: 'bytes=0-15',
        });

        const missingObjectError = Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
        });
        send.mockRejectedValueOnce(missingObjectError as never);
        await expect(
          buildService().readObjectPrefixBytes(VJ_CLIP_KEY),
        ).rejects.toBe(missingObjectError);
      });
    });
  });

  describe('studioStreamExpirySeconds', () => {
    it.each([
      [null, 900],
      [Number.NaN, 900],
      [0, 900],
      [120, 900],
      [300, 900],
      [301, 901],
      [3600, 4200],
      [20999, 21599],
      [21000, 21600],
      [86400, 21600],
    ])(
      'gives a %p second track a %i second link',
      (durationSeconds, expected) => {
        expect(studioStreamExpirySeconds(durationSeconds)).toBe(expected);
      },
    );
  });
});
