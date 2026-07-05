import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

// Orphan cleanup: a presigned upload can be abandoned (a user gets the URL and
// never uploads, or uploads then discards the draft profile), leaving objects
// under avatars/ and work/ that no DB row references. Provision an S3 bucket
// lifecycle rule that expires objects under those prefixes after N days; a row
// only becomes "claimed" once its fileUrl is persisted on a profile/title, so
// anything older than the presign window that is still unreferenced is safe to
// reap. (Alternative: track claimed keys in a table and sweep the difference.)

export interface PresignedUpload {
  // Browser POSTs multipart/form-data to `url` with `fields` + the file last.
  url: string;
  fields: Record<string, string>;
  fileUrl: string;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  // Presigned POST (not PUT): only a POST policy can enforce a maximum object
  // size (content-length-range) and pin the Content-Type. A presigned PUT URL
  // can neither, so a caller could upload an arbitrarily large or mistyped
  // object. The client must echo `fields` and append the file as the last
  // multipart part.
  async createPresignedUpload(
    key: string,
    contentType: string,
    maxBytes: number,
  ): Promise<PresignedUpload> {
    const bucket = this.requireConfig('storage.bucket');
    const { url, fields } = await createPresignedPost(this.s3(), {
      Bucket: bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: PRESIGN_EXPIRY_SECONDS,
    });
    return { url, fields, fileUrl: this.fileUrl(bucket, key) };
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
