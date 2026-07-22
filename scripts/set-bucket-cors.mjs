// One-off: apply a CORS policy to the object-storage bucket so the browser can
// PUT directly to presigned upload URLs. Run with the same AWS_* env the app uses:
//
//   node --env-file=.env scripts/set-bucket-cors.mjs
//
// (or export AWS_ENDPOINT_URL / AWS_DEFAULT_REGION / AWS_S3_BUCKET_NAME /
//  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY first, then run without --env-file)
//
// The allowed browser origins are read from FRONTEND_URL (the same allowlist the
// API uses for CORS), so keep that set in the env you point this at.
//
// Re-running is safe: PutBucketCors replaces the whole policy each time.
import {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';

const {
  AWS_ENDPOINT_URL,
  AWS_DEFAULT_REGION,
  AWS_S3_BUCKET_NAME,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} = process.env;

// Behaviour is tuned for running as an unconditional deploy step (see the
// docker-compose / Dockerfile deploy chain):
//   - NONE of the bucket vars set  -> object storage isn't configured in this
//     env, so skip cleanly (exit 0). This is what lets the step sit in a `&&`
//     deploy chain without blocking boot on a bucket-less stack.
//   - SOME but not all set         -> a genuine misconfiguration; fail loudly
//     (exit 1) rather than applying a policy against a half-configured client.
const requiredVars = {
  AWS_ENDPOINT_URL,
  AWS_DEFAULT_REGION,
  AWS_S3_BUCKET_NAME,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
};
const missingVars = Object.entries(requiredVars)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingVars.length === Object.keys(requiredVars).length) {
  console.log('Object storage not configured (no AWS_* vars); skipping bucket CORS.');
  process.exit(0);
}
if (missingVars.length > 0) {
  console.error(`Missing required env var(s): ${missingVars.join(', ')}`);
  process.exit(1);
}

// The bucket's allowed browser origins come from the SAME FRONTEND_URL the API
// uses for HTTP/socket CORS — a browser allowed to call the API is allowed to
// PUT to the bucket, by construction, and the two can never drift. This mirrors
// parseFrontendOrigins() in src/config/frontend-origins.ts; it's re-implemented
// here (not imported) so the script runs standalone without a compiled dist/.
//
// FRONTEND_URL is a comma-separated allowlist of exact origins (no trailing
// slash). Point this script at the env of the bucket you're configuring: your
// prod .env yields prod origins, your dev .env yields localhost.
const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';
const parsedOrigins = (process.env.FRONTEND_URL ?? '')
  .split(',')
  .map((entry) => entry.trim().replace(/\/+$/, ''))
  .filter((entry) => entry.length > 0);
const allowedOrigins =
  parsedOrigins.length > 0
    ? Array.from(new Set(parsedOrigins))
    : [DEFAULT_FRONTEND_ORIGIN];

console.log(`Applying bucket CORS for origins: ${allowedOrigins.join(', ')}`);

const client = new S3Client({
  endpoint: AWS_ENDPOINT_URL,
  region: AWS_DEFAULT_REGION,
  forcePathStyle: false,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

await client.send(
  new PutBucketCorsCommand({
    Bucket: AWS_S3_BUCKET_NAME,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: allowedOrigins,
          // GET covers presigned downloads; PUT covers presigned uploads.
          AllowedMethods: ['GET', 'PUT'],
          // "*" so the SDK's Content-Type + x-amz-checksum-* / x-amz-sdk-*
          // request headers all pass the preflight.
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);

console.log('Applied CORS policy. Bucket now returns:');
const current = await client.send(
  new GetBucketCorsCommand({ Bucket: AWS_S3_BUCKET_NAME }),
);
console.log(JSON.stringify(current.CORSRules, null, 2));
