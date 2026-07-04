import {
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { MuxService } from './mux.service';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const WEBHOOK_SECRET = 'test-webhook-secret';

const baseConfig: Record<string, string | undefined> = {
  'mux.tokenId': 'test-token-id',
  'mux.tokenSecret': 'test-token-secret',
  'mux.webhookSecret': WEBHOOK_SECRET,
  'mux.signingKeyId': 'test-signing-key',
  'mux.signingPrivateKey': Buffer.from(privateKey).toString('base64'),
  'app.frontendUrl': 'http://localhost:5173',
};

function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

function extractToken(url: string): string {
  return new URL(url).searchParams.get('token') as string;
}

async function makeService(
  overrides: Record<string, string | undefined> = {},
): Promise<MuxService> {
  const values = { ...baseConfig, ...overrides };
  const config = {
    get: jest.fn((key: string, def?: unknown) => values[key] ?? def),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [MuxService, { provide: ConfigService, useValue: config }],
  }).compile();
  return module.get(MuxService);
}

describe('MuxService.signPlaybackTokens', () => {
  it('signs video/thumbnail/storyboard tokens with the right claims', async () => {
    const service = await makeService();
    const tokens = await service.signPlaybackTokens('play-123', 7200);

    expect(tokens.hlsUrl).toContain(
      'https://stream.mux.com/play-123.m3u8?token=',
    );
    expect(tokens.posterUrl).toContain(
      'https://image.mux.com/play-123/thumbnail.webp?token=',
    );
    expect(tokens.storyboardUrl).toContain(
      'https://image.mux.com/play-123/storyboard.vtt?token=',
    );

    const video = decodeJwtPayload(extractToken(tokens.hlsUrl));
    const thumb = decodeJwtPayload(extractToken(tokens.posterUrl));
    const board = decodeJwtPayload(extractToken(tokens.storyboardUrl));
    expect(video.sub).toBe('play-123');
    expect(video.aud).toBe('v');
    expect(thumb.aud).toBe('t');
    expect(board.aud).toBe('s');

    // TTL = duration + 30 min = 9,000 s
    const expectedExp = Math.floor(Date.now() / 1000) + 9000;
    expect(video.exp as number).toBeGreaterThanOrEqual(expectedExp - 30);
    expect(video.exp as number).toBeLessThanOrEqual(expectedExp + 30);
  });

  it('clamps the TTL to a 1 hour floor', async () => {
    const service = await makeService();
    const tokens = await service.signPlaybackTokens('play-123', 600);
    const video = decodeJwtPayload(extractToken(tokens.hlsUrl));
    const expectedExp = Math.floor(Date.now() / 1000) + 3600;
    expect(video.exp as number).toBeGreaterThanOrEqual(expectedExp - 30);
    expect(video.exp as number).toBeLessThanOrEqual(expectedExp + 30);
  });

  it('clamps the TTL to a 12 hour cap', async () => {
    const service = await makeService();
    const tokens = await service.signPlaybackTokens('play-123', 86_400);
    const video = decodeJwtPayload(extractToken(tokens.hlsUrl));
    const expectedExp = Math.floor(Date.now() / 1000) + 43_200;
    expect(video.exp as number).toBeGreaterThanOrEqual(expectedExp - 30);
    expect(video.exp as number).toBeLessThanOrEqual(expectedExp + 30);
  });

  it('uses the 1 hour floor when duration is unknown', async () => {
    const service = await makeService();
    const tokens = await service.signPlaybackTokens('play-123', null);
    const video = decodeJwtPayload(extractToken(tokens.hlsUrl));
    const expectedExp = Math.floor(Date.now() / 1000) + 3600;
    expect(video.exp as number).toBeGreaterThanOrEqual(expectedExp - 30);
    expect(video.exp as number).toBeLessThanOrEqual(expectedExp + 30);
  });

  it('reports expiresAt matching the token exp', async () => {
    const service = await makeService();
    const tokens = await service.signPlaybackTokens('play-123', 7200);
    const video = decodeJwtPayload(extractToken(tokens.hlsUrl));
    expect(
      Math.abs(tokens.expiresAt.getTime() / 1000 - (video.exp as number)),
    ).toBeLessThanOrEqual(2);
  });

  it('throws a 500 when signing config is missing', async () => {
    const service = await makeService({ 'mux.signingKeyId': undefined });
    await expect(
      service.signPlaybackTokens('play-123', 7200),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('MuxService.deleteAsset', () => {
  it('swallows a 404 from Mux', async () => {
    const service = await makeService();
    (service as unknown as { client: unknown }).client = {
      video: {
        assets: { delete: jest.fn().mockRejectedValue({ status: 404 }) },
      },
    };
    await expect(service.deleteAsset('asset-1')).resolves.toBeUndefined();
  });

  it('rethrows non-404 errors', async () => {
    const service = await makeService();
    (service as unknown as { client: unknown }).client = {
      video: {
        assets: { delete: jest.fn().mockRejectedValue({ status: 500 }) },
      },
    };
    await expect(service.deleteAsset('asset-1')).rejects.toEqual({
      status: 500,
    });
  });
});

describe('MuxService.createDirectUpload', () => {
  it('requests a signed-policy basic-quality upload and maps the result', async () => {
    const service = await makeService();
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'up-1', url: 'https://storage.mux.com/put' });
    (service as unknown as { client: unknown }).client = {
      video: { uploads: { create } },
    };

    const result = await service.createDirectUpload('title-uuid');

    expect(create).toHaveBeenCalledWith({
      cors_origin: 'http://localhost:5173',
      new_asset_settings: {
        playback_policy: ['signed'],
        video_quality: 'basic',
        passthrough: 'title-uuid',
      },
    });
    expect(result).toEqual({
      uploadId: 'up-1',
      uploadUrl: 'https://storage.mux.com/put',
    });
  });
});

describe('MuxService.getUpload / getAsset', () => {
  it('maps upload state', async () => {
    const service = await makeService();
    (service as unknown as { client: unknown }).client = {
      video: {
        uploads: {
          retrieve: jest
            .fn()
            .mockResolvedValue({ status: 'asset_created', asset_id: 'as-1' }),
        },
      },
    };
    await expect(service.getUpload('up-1')).resolves.toEqual({
      status: 'asset_created',
      assetId: 'as-1',
    });
  });

  it('maps asset state including rounded duration and first playback id', async () => {
    const service = await makeService();
    (service as unknown as { client: unknown }).client = {
      video: {
        assets: {
          retrieve: jest.fn().mockResolvedValue({
            status: 'ready',
            playback_ids: [{ id: 'pb-1', policy: 'signed' }],
            duration: 7199.62,
            aspect_ratio: '16:9',
          }),
        },
      },
    };
    await expect(service.getAsset('as-1')).resolves.toEqual({
      status: 'ready',
      playbackId: 'pb-1',
      durationSeconds: 7200,
      aspectRatio: '16:9',
      errorMessage: null,
    });
  });

  it('maps errored asset state', async () => {
    const service = await makeService();
    (service as unknown as { client: unknown }).client = {
      video: {
        assets: {
          retrieve: jest.fn().mockResolvedValue({
            status: 'errored',
            errors: {
              type: 'invalid_input',
              messages: ['bad codec', 'no audio'],
            },
          }),
        },
      },
    };
    await expect(service.getAsset('as-1')).resolves.toEqual({
      status: 'errored',
      playbackId: null,
      durationSeconds: null,
      aspectRatio: null,
      errorMessage: 'bad codec; no audio',
    });
  });
});

describe('MuxService.verifyWebhook', () => {
  const body = JSON.stringify({
    type: 'video.asset.ready',
    data: { id: 'as-1' },
  });

  function signatureFor(payload: string, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    return `t=${timestamp},v1=${digest}`;
  }

  it('accepts a correctly signed payload and returns the parsed event', async () => {
    const service = await makeService();
    const event = (await service.verifyWebhook(body, {
      'mux-signature': signatureFor(body, WEBHOOK_SECRET),
    })) as { type: string };
    expect(event.type).toBe('video.asset.ready');
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const service = await makeService();
    await expect(
      service.verifyWebhook(body, {
        'mux-signature': signatureFor(body, 'wrong-secret'),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a missing signature header', async () => {
    const service = await makeService();
    await expect(service.verifyWebhook(body, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws a 500 when the webhook secret is not configured', async () => {
    const service = await makeService({ 'mux.webhookSecret': undefined });
    await expect(
      service.verifyWebhook(body, {
        'mux-signature': signatureFor(body, WEBHOOK_SECRET),
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
