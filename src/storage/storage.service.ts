import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

@Injectable()
export class StorageService {
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  async createPresignedUpload(
    key: string,
    contentType: string,
  ): Promise<{ uploadUrl: string; fileUrl: string }> {
    const bucket = this.requireConfig('storage.bucket');
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.s3(), command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
    return { uploadUrl, fileUrl: this.fileUrl(bucket, key) };
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
      throw new InternalServerErrorException(
        `Object storage is not configured (missing ${key})`,
      );
    }
    return value;
  }
}
