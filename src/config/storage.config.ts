import { registerAs } from '@nestjs/config';

// Railway injects these names directly into any service linked to a Bucket,
// so a linked bucket works with no dashboard variable mapping. There is no
// region default: Railway's value is `auto`, and guessing a wrong region fails
// more confusingly than a missing one.
export default registerAs('storage', () => ({
  endpoint: process.env.ENDPOINT,
  region: process.env.REGION,
  bucket: process.env.BUCKET,
  accessKey: process.env.ACCESS_KEY_ID,
  secretKey: process.env.SECRET_ACCESS_KEY,
}));
