import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

// Orphan cleanup is UNSOLVED and deliberately out of scope. A presigned upload
// can be abandoned (a user gets the URL and never uploads, or uploads then
// discards the draft), leaving objects no DB row references. Railway Buckets
// have no lifecycle rules, so this cannot be pushed onto the bucket the way an
// S3 deployment would. The cost is storage only, never correctness. The fix,
// when it is worth building, is a scheduled sweep that lists bucket keys and
// deletes those not referenced by any image column.

export interface PresignedUpload {
  /** Short-lived presigned URL to `PUT` the raw bytes to (direct-to-storage). */
  uploadUrl: string;
  /** The storage key the caller persists once the PUT succeeds. */
  key: string;
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
    const command = new PutObjectCommand({
      Bucket: this.requireConfig('storage.bucket'),
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.storageClient(), command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
    return { uploadUrl, key, expiresIn: PRESIGN_EXPIRY_SECONDS };
  }

  // Presigned GET: Railway Buckets are private with no public URL, so this is
  // the only way to hand bytes to a browser. `FilesController` authorizes the
  // request first, then redirects here — the bytes come straight from the
  // bucket and never pass through this service.
  async createPresignedDownload(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.requireConfig('storage.bucket'),
      Key: key,
    });
    return getSignedUrl(this.storageClient(), command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
  }

  private storageClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.requireConfig('storage.endpoint'),
        region: this.requireConfig('storage.region'),
        // Railway Buckets use virtual-hosted-style URLs (bucket as subdomain).
        // Path-style requests are rejected.
        forcePathStyle: false,
        credentials: {
          accessKeyId: this.requireConfig('storage.accessKey'),
          secretAccessKey: this.requireConfig('storage.secretKey'),
        },
      });
    }
    return this.client;
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      // Log the exact missing key for operators; never leak internal config
      // key names to API clients.
      this.logger.error(`Object storage is not configured (missing ${key})`);
      throw new InternalServerErrorException(
        'Object storage is not configured',
      );
    }
    return value;
  }
}
