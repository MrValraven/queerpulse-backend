import { registerAs } from '@nestjs/config';

// S3-compatible object storage. In production this is a Railway Bucket, which
// is backed by Tigris under the hood (endpoint `*.t3.storageapi.dev`, keys
// prefixed `tid_`/`tsec_`) — the client below talks plain S3 to it either way.
// Railway injects these names directly into any service linked to a Bucket, so
// a linked bucket works with no dashboard variable mapping. There is no region
// default: Railway's value is `auto`, and guessing a wrong region fails more
// confusingly than a missing one.
export default registerAs('storage', () => ({
  endpoint: process.env.AWS_ENDPOINT_URL,
  region: process.env.AWS_DEFAULT_REGION,
  bucket: process.env.AWS_S3_BUCKET_NAME,
  accessKey: process.env.AWS_ACCESS_KEY_ID,
  secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  // Local development only: the MinIO container in docker-compose.yml serves
  // buckets at path-style URLs (`localhost:9000/<bucket>/<key>`). Only the
  // exact string `true` turns it on, and env validation refuses it when
  // NODE_ENV=production, so the Railway Bucket keeps virtual-hosted-style URLs.
  isForcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
  // Local development only: the bucket endpoint as a BROWSER reaches it. The
  // `api` container in docker-compose.yml talks to MinIO at
  // `http://minio:9000`, a name only the Docker network resolves, so every
  // presigned URL handed to a browser is signed for `http://localhost:9000`
  // instead (see StorageService.presigningClient). Server-side calls keep
  // using `endpoint`. Unset (or empty) signs with `endpoint`, as production
  // does; env validation refuses it when NODE_ENV=production.
  publicEndpoint: process.env.AWS_PUBLIC_ENDPOINT_URL || undefined,
}));
