import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Mux from '@mux/mux-node';

const TOKEN_TTL_FLOOR_SECONDS = 3600; // 1 hour
const TOKEN_TTL_CAP_SECONDS = 43_200; // 12 hours
const TOKEN_TTL_GRACE_SECONDS = 1800; // 30 min past the title's duration

export type UploadState = {
  status: string;
  assetId: string | null;
};

export type AssetState = {
  status: 'preparing' | 'ready' | 'errored';
  playbackId: string | null;
  durationSeconds: number | null;
  aspectRatio: string | null;
  errorMessage: string | null;
};

export type PlaybackTokens = {
  hlsUrl: string;
  posterUrl: string;
  storyboardUrl: string;
  expiresAt: Date;
};

// The only file that talks to the Mux SDK — everything else in the module
// depends on these methods, which is also the seam for a future provider swap.
@Injectable()
export class MuxService {
  private client: Mux | null = null;

  constructor(private readonly config: ConfigService) {}

  async createDirectUpload(
    passthrough: string,
  ): Promise<{ uploadId: string; uploadUrl: string }> {
    const upload = await this.mux().video.uploads.create({
      cors_origin: this.config.get<string>(
        'app.frontendUrl',
        'http://localhost:5173',
      ),
      new_asset_settings: {
        playback_policy: ['signed'],
        video_quality: 'basic',
        passthrough,
      },
    });
    if (!upload.url) {
      throw new InternalServerErrorException(
        'Mux returned a direct upload without a URL',
      );
    }
    return { uploadId: upload.id, uploadUrl: upload.url };
  }

  async getUpload(uploadId: string): Promise<UploadState> {
    const upload = await this.mux().video.uploads.retrieve(uploadId);
    return { status: upload.status, assetId: upload.asset_id ?? null };
  }

  async getAsset(assetId: string): Promise<AssetState> {
    const asset = await this.mux().video.assets.retrieve(assetId);
    return {
      status: asset.status,
      playbackId: asset.playback_ids?.[0]?.id ?? null,
      durationSeconds:
        asset.duration != null ? Math.round(asset.duration) : null,
      aspectRatio: asset.aspect_ratio ?? null,
      errorMessage: asset.errors?.messages?.length
        ? asset.errors.messages.join('; ')
        : null,
    };
  }

  async deleteAsset(assetId: string): Promise<void> {
    try {
      await this.mux().video.assets.delete(assetId);
    } catch (err) {
      if ((err as { status?: number })?.status === 404) {
        return; // already gone — deletion is idempotent
      }
      throw err;
    }
  }

  async signPlaybackTokens(
    playbackId: string,
    durationSeconds: number | null,
  ): Promise<PlaybackTokens> {
    const keyId = this.requireConfig('mux.signingKeyId');
    const keySecret = this.requireConfig('mux.signingPrivateKey');
    const ttlSeconds = Math.min(
      Math.max(
        (durationSeconds ?? 0) + TOKEN_TTL_GRACE_SECONDS,
        TOKEN_TTL_FLOOR_SECONDS,
      ),
      TOKEN_TTL_CAP_SECONDS,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const sign = (type: 'video' | 'thumbnail' | 'storyboard') =>
      this.mux().jwt.signPlaybackId(playbackId, {
        keyId,
        keySecret,
        expiration: `${ttlSeconds}s`,
        type,
      });
    const [video, thumbnail, storyboard] = await Promise.all([
      sign('video'),
      sign('thumbnail'),
      sign('storyboard'),
    ]);
    return {
      hlsUrl: `https://stream.mux.com/${playbackId}.m3u8?token=${video}`,
      posterUrl: `https://image.mux.com/${playbackId}/thumbnail.webp?token=${thumbnail}`,
      storyboardUrl: `https://image.mux.com/${playbackId}/storyboard.vtt?token=${storyboard}`,
      expiresAt,
    };
  }

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, unknown>,
  ): Promise<unknown> {
    const secret = this.requireConfig('mux.webhookSecret');
    try {
      // unwrap is async in SDK v14 (WebCrypto HMAC) — must await here so
      // signature failures are caught and mapped, not left as rejections.
      return await this.mux().webhooks.unwrap(
        rawBody,
        headers as Record<string, string>,
        secret,
      );
    } catch {
      throw new ForbiddenException('Invalid webhook signature');
    }
  }

  private mux(): Mux {
    if (!this.client) {
      this.client = new Mux({
        tokenId: this.requireConfig('mux.tokenId'),
        tokenSecret: this.requireConfig('mux.tokenSecret'),
      });
    }
    return this.client;
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new InternalServerErrorException(
        `Mux is not configured (missing ${key})`,
      );
    }
    return value;
  }
}
