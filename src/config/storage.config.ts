import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET,
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY,
  publicUrl: process.env.S3_PUBLIC_URL, // optional CDN/base url for fileUrl
}));
