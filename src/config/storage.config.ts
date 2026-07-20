import { registerAs } from '@nestjs/config';

// Railway injects these names directly into any service linked to a Bucket,
// so a linked bucket works with no dashboard variable mapping. There is no
// region default: Railway's value is `auto`, and guessing a wrong region fails
// more confusingly than a missing one.
export default registerAs('storage', () => ({
  endpoint: process.env.AWS_ENDPOINT_URL,
  region: process.env.AWS_DEFAULT_REGION,
  bucket: process.env.AWS_S3_BUCKET_NAME,
  accessKey: process.env.AWS_ACCESS_KEY_ID,
  secretKey: process.env.AWS_SECRET_ACCESS_KEY,
}));
