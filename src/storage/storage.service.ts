import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

// Orphan cleanup: a presigned upload can be abandoned (a user gets the URL and
// never uploads, or uploads then discards the draft profile), leaving objects
// under avatars/ and work/ that no DB row references. Provision an S3 bucket
// lifecycle rule that expires objects under those prefixes after N days; a row
// only becomes "claimed" once its publicUrl is persisted on a profile/title,
// so anything older than the presign window that is still unreferenced is
// safe to reap. (Alternative: track claimed keys in a table and sweep the
// difference.)

export interface PresignedUpload {
  /** Short-lived presigned URL to `PUT` the raw bytes to (direct-to-storage). */
  uploadUrl: string;
  /** Stable, CDN-served URL we persist once the PUT succeeds. */
  publicUrl: string;
  /** Seconds until `uploadUrl` expires. */
  expiresIn: number;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  // Presigned PUT: the caller `PUT`s the raw bytes straight to `uploadUrl`
  // with no cookies/CSRF — the signature alone authorizes writing this one
  // key, and the pinned `ContentType` means a client can't silently swap it
  // after the signature is minted. Unlike a POST policy, a presigned PUT URL
  // cannot itself enforce a content-length-range condition, so the caller
  // (`UploadsController`) is responsible for rejecting an over-cap
  // `byteSize` and a disallowed content type *before* calling this.
  async createPresignedUpload(
    key: string,
    contentType: string,
  ): Promise<PresignedUpload> {
    const bucket = this.requireConfig('storage.bucket');
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.s3(), command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
    return {
      uploadUrl,
      publicUrl: this.fileUrl(bucket, key),
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    };
  }

  private s3(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.config.get<string>('storage.endpoint'),
        region: this.config.get<string>('storage.region', 'us-east-1'),
        forcePathStyle: true, // S3-compatible providers (MinIO, R2, etc.)
        credentials: {
          accessKeyId: this.requireConfig('storage.accessKey'),
          secretAccessKey: this.requireConfig('storage.secretKey'),
        },
      });
    }
    return this.client;
  }

  private fileUrl(bucket: string, key: string): string {
    const publicUrl = this.config.get<string>('storage.publicUrl');
    if (publicUrl) {
      return `${publicUrl.replace(/\/$/, '')}/${key}`;
    }
    // S3-compatible providers (MinIO/R2) set a custom endpoint → path-style URL.
    const endpoint = this.config.get<string>('storage.endpoint');
    if (endpoint) {
      return `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`;
    }
    // Real AWS S3 with no custom endpoint: virtual-hosted-style URL.
    const region = this.config.get<string>('storage.region', 'us-east-1');
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      // Log the exact missing key for operators; never leak internal config
      // key names (S3_*) to API clients.
      this.logger.error(`Object storage is not configured (missing ${key})`);
      throw new InternalServerErrorException(
        'Object storage is not configured',
      );
    }
    return value;
  }
}
