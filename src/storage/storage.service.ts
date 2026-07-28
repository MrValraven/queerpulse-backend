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
  // after the signature is minted.
  //
  // A presigned PUT cannot carry a content-length-*range* condition the way a
  // POST policy can, but signing an exact `ContentLength` DOES bind the upload
  // to that byte count: it becomes a signed header, so a client that streams
  // more (or fewer) bytes than declared fails the signature. `UploadsController`
  // still rejects an over-cap `byteSize` up front (a large declared size never
  // gets a signature at all); pinning `ContentLength` here closes the gap where
  // a client declared a small `byteSize` to pass that check, then PUT a much
  // larger body — previously the client-declared size was the *only* limit.
  // `contentLength` is optional because the legacy avatar/work-image routes
  // don't send a byte size; those keep the up-front check only.
  async createPresignedUpload(
    key: string,
    contentType: string,
    contentLength?: number,
  ): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.requireConfig('storage.bucket'),
      Key: key,
      ContentType: contentType,
      ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
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
