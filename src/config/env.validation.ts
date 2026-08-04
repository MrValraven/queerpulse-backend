import { plainToInstance } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { missingLaunchedFeatureEnv } from '../launchedFeatures';
import { invalidFrontendOrigins } from './frontend-origins';

/**
 * A cookie `Domain` attribute: a bare hostname, optionally leading-dotted to
 * cover subdomains (`.queerpulse.com`). Rejects schemes, ports, paths and
 * whitespace. `localhost` is allowed for completeness, though the correct
 * localhost setting is to leave COOKIE_DOMAIN unset entirely.
 */
function isCookieDomain(value: string): boolean {
  return /^\.?(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i.test(
    value,
  );
}

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  // Optional so the `?? 3000` fallbacks in app.config/main are reachable rather
  // than dead code. Platforms that inject PORT (Railway, Heroku) still win.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  GOOGLE_CLIENT_ID!: string;

  @IsString()
  GOOGLE_CLIENT_SECRET!: string;

  @IsString()
  GOOGLE_CALLBACK_URL!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_TTL?: string;

  @IsOptional()
  @IsString()
  FRONTEND_URL?: string;

  @IsOptional() @IsString() API_URL?: string;

  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  @IsOptional()
  @IsString()
  LOG_LEVEL?: string;

  @IsOptional()
  @IsString()
  LOG_PRETTY?: string;

  // pg connection-pool + timeout tuning. All optional with production-safe
  // defaults applied in src/config/database.config.ts; validated here so a
  // typo (e.g. a non-numeric value) fails fast at boot instead of silently
  // falling back to a default that masks the misconfiguration.
  @IsOptional()
  @IsNumber()
  @Min(1)
  DATABASE_POOL_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  DATABASE_POOL_MIN?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  DATABASE_CONNECTION_TIMEOUT_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  DATABASE_IDLE_TIMEOUT_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  DATABASE_STATEMENT_TIMEOUT_MS?: number;

  // Slow-query logging threshold (TypeORM `maxQueryExecutionTime`) — logs,
  // never kills, a query slower than this. Default (500ms) applied in
  // src/config/database.config.ts.
  @IsOptional()
  @IsNumber()
  @Min(0)
  DATABASE_SLOW_QUERY_THRESHOLD_MS?: number;

  @IsOptional() @IsString() AWS_ENDPOINT_URL?: string;
  @IsOptional() @IsString() AWS_DEFAULT_REGION?: string;
  @IsOptional() @IsString() AWS_S3_BUCKET_NAME?: string;
  @IsOptional() @IsString() AWS_ACCESS_KEY_ID?: string;
  @IsOptional() @IsString() AWS_SECRET_ACCESS_KEY?: string;

  @IsOptional() @IsString() MUX_TOKEN_ID?: string;
  @IsOptional() @IsString() MUX_TOKEN_SECRET?: string;
  @IsOptional() @IsString() MUX_WEBHOOK_SECRET?: string;
  @IsOptional() @IsString() MUX_SIGNING_KEY_ID?: string;
  @IsOptional() @IsString() MUX_SIGNING_PRIVATE_KEY?: string;

  @IsOptional() @IsString() VAPID_PUBLIC_KEY?: string;
  @IsOptional() @IsString() VAPID_PRIVATE_KEY?: string;
  @IsOptional() @IsString() VAPID_SUBJECT?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  INVITE_MONTHLY_QUOTA?: number;

  // Retention-cron thresholds (days) and batch sizing. All optional with
  // production-safe defaults applied in src/config/retention.config.ts;
  // validated here so a typo (e.g. a non-numeric or zero value) fails fast at
  // boot instead of silently falling back to a default that masks it.
  @IsOptional()
  @IsNumber()
  @Min(1)
  DATA_EXPORT_RETENTION_DAYS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  NOTIFICATION_RETENTION_DAYS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  PUSH_SUBSCRIPTION_STALE_DAYS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  RETENTION_BATCH_SIZE?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  RETENTION_MAX_BATCHES_PER_RUN?: number;

  // Optional because it is absent in every environment except during one-time
  // founder bootstrap — absence is the normal, safe state, and it is what makes
  // the genesis endpoints 404.
  @IsOptional()
  @IsEmail()
  GENESIS_EMAIL?: string;

  // Bearer token guarding GET /metrics (see MetricsTokenGuard). Optional in
  // every environment: leave it unset to let Railway scrape /metrics over its
  // private network, or set it (min 16 chars) to require a bearer token.
  @IsOptional()
  @IsString()
  @MinLength(16)
  METRICS_TOKEN?: string;

  // --- Multi-replica gate ---------------------------------------------------
  // This app keeps three stores IN PROCESS MEMORY — the @nestjs/throttler
  // counters, socket.io presence/fan-out (no Redis adapter), and the presence
  // map — so it is SINGLE-REPLICA ONLY. Run N replicas and every rate limit
  // becomes N×, live socket fan-out (revoke/lockdown/presence) reaches only the
  // instance that handled the event, and presence goes inconsistent. These
  // knobs make that constraint enforced at boot rather than merely documented.

  // Declared replica/worker count the operator is scaling to. `REPLICA_COUNT`
  // is the explicit knob; `WEB_CONCURRENCY` is honoured as the de-facto standard
  // (each worker is a separate process with its own in-memory stores, so it
  // multiplies the same way). Absent ⇒ 1.
  @IsOptional()
  @IsNumber()
  @Min(1)
  REPLICA_COUNT?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  WEB_CONCURRENCY?: number;

  // Explicit override acknowledging the single-replica constraint. Only the
  // exact string `true` enables it; see the cross-field rule below.
  @IsOptional()
  @IsString()
  ALLOW_MULTI_REPLICA?: string;
}

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  // Cross-field rules that class-validator decorators can't express cleanly.
  const problems: string[] = [];

  if (validated.JWT_ACCESS_SECRET === validated.JWT_REFRESH_SECRET) {
    problems.push(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values (identical secrets allow access/refresh token confusion)',
    );
  }

  if (validated.NODE_ENV === NodeEnv.Production && !validated.FRONTEND_URL) {
    problems.push('FRONTEND_URL is required when NODE_ENV=production');
  }

  if (validated.NODE_ENV === NodeEnv.Production && !validated.API_URL) {
    problems.push(
      'API_URL is required when NODE_ENV=production (image URLs would point at localhost otherwise)',
    );
  }

  // Storage is not optional in production — profile avatars and every upload
  // route depend on it. Left unset, the app boots healthy and uploads fail at
  // runtime, per-request, for users. Fail at boot instead. AWS_ENDPOINT_URL and
  // AWS_DEFAULT_REGION are required too: Railway is never reachable at a
  // provider default.
  if (validated.NODE_ENV === NodeEnv.Production) {
    const missingStorage = (
      [
        ['AWS_ENDPOINT_URL', validated.AWS_ENDPOINT_URL],
        ['AWS_DEFAULT_REGION', validated.AWS_DEFAULT_REGION],
        ['AWS_S3_BUCKET_NAME', validated.AWS_S3_BUCKET_NAME],
        ['AWS_ACCESS_KEY_ID', validated.AWS_ACCESS_KEY_ID],
        ['AWS_SECRET_ACCESS_KEY', validated.AWS_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      problems.push(
        `${missingStorage.join(', ')} ${missingStorage.length === 1 ? 'is' : 'are'} required when NODE_ENV=production (uploads fail at runtime otherwise)`,
      );
    }
  }

  // Web Push (VAPID) is optional overall, but all-or-nothing: a partially set
  // trio would boot healthy and fail to send pushes at runtime instead of
  // failing fast at boot.
  if (validated.NODE_ENV === NodeEnv.Production) {
    const missingPush = (
      [
        ['VAPID_PUBLIC_KEY', validated.VAPID_PUBLIC_KEY],
        ['VAPID_PRIVATE_KEY', validated.VAPID_PRIVATE_KEY],
        ['VAPID_SUBJECT', validated.VAPID_SUBJECT],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingPush.length > 0 && missingPush.length < 3) {
      problems.push(
        `${missingPush.join(', ')} ${missingPush.length === 1 ? 'is' : 'are'} required when the other VAPID_* keys are set (Web Push is all-or-nothing)`,
      );
    }
  }

  // FRONTEND_URL is a strict, comma-separated allowlist of EXACT origins. A
  // trailing slash or a path never matches a browser `Origin` header, so a typo
  // here reads as "CORS is broken" at runtime; fail at boot with the bad entry
  // named instead.
  const badOrigins = invalidFrontendOrigins(validated.FRONTEND_URL);
  if (badOrigins.length > 0) {
    problems.push(
      `FRONTEND_URL must be a comma-separated list of exact origins (scheme + host, no path or trailing slash); invalid: ${badOrigins.join(', ')}`,
    );
  }

  // COOKIE_DOMAIN is a cookie Domain attribute (e.g. `.queerpulse.com`), not a
  // URL. Passing an origin here makes Express emit a cookie the browser drops
  // silently — auth then "just doesn't work" with no error anywhere.
  if (validated.COOKIE_DOMAIN && !isCookieDomain(validated.COOKIE_DOMAIN)) {
    problems.push(
      `COOKIE_DOMAIN must be a bare domain such as .queerpulse.com (no scheme, port or path); got: ${validated.COOKIE_DOMAIN}`,
    );
  }

  // Mux is all-or-nothing: if any credential is set, the core trio must be too,
  // otherwise webhooks 500 at runtime instead of failing fast at boot.
  const muxVars = [
    validated.MUX_TOKEN_ID,
    validated.MUX_TOKEN_SECRET,
    validated.MUX_WEBHOOK_SECRET,
    validated.MUX_SIGNING_KEY_ID,
    validated.MUX_SIGNING_PRIVATE_KEY,
  ];
  if (muxVars.some((v) => v !== undefined && v !== '')) {
    if (
      !validated.MUX_TOKEN_ID ||
      !validated.MUX_TOKEN_SECRET ||
      !validated.MUX_WEBHOOK_SECRET
    ) {
      problems.push(
        'MUX_TOKEN_ID, MUX_TOKEN_SECRET and MUX_WEBHOOK_SECRET are all required when any MUX_* variable is set',
      );
    }
    if (
      Boolean(validated.MUX_SIGNING_KEY_ID) !==
      Boolean(validated.MUX_SIGNING_PRIVATE_KEY)
    ) {
      problems.push(
        'MUX_SIGNING_KEY_ID and MUX_SIGNING_PRIVATE_KEY must be set together (required for signed playback)',
      );
    }
  }

  // /metrics is guarded by METRICS_TOKEN when set (see MetricsTokenGuard).
  // It is optional in every environment: we rely on Railway's private network
  // for observability, so an unset token leaves the endpoint open to the
  // internal network rather than being a hard boot failure in production.

  // Single-replica gate. The throttler store, socket.io fan-out and presence
  // map all live in process memory (see the ThrottlerModule + ChatGateway
  // notes), so running >1 replica/worker silently breaks rate limits, live
  // socket delivery and presence. If the operator declares more than one
  // without explicitly acknowledging the constraint, fail fast at boot.
  const declaredReplicas = Math.max(
    validated.REPLICA_COUNT ?? 1,
    validated.WEB_CONCURRENCY ?? 1,
  );
  const allowMultiReplica = validated.ALLOW_MULTI_REPLICA === 'true';
  if (declaredReplicas > 1) {
    if (!allowMultiReplica) {
      problems.push(
        `This app is single-replica only (in-memory throttler + no socket.io Redis adapter + in-memory presence), but REPLICA_COUNT/WEB_CONCURRENCY declares ${declaredReplicas}. Scale to one replica, or wire the shared stores (Redis throttler storage + @socket.io/redis-adapter + Redis presence) and set ALLOW_MULTI_REPLICA=true to acknowledge you have`,
      );
    } else {
      // Acknowledged. We cannot verify the shared stores are actually wired
      // (they aren't shipped yet), so this is a loud warning, not silence: the
      // operator is asserting responsibility for having wired them.
      console.warn(
        `[env] ALLOW_MULTI_REPLICA=true with ${declaredReplicas} declared replicas/workers. ` +
          'The in-memory throttler, socket.io fan-out and presence map are NOT shared across processes; ' +
          'rate limits, live socket delivery (session-revoke/lockdown/presence) and presence will be WRONG ' +
          'unless you have wired Redis throttler storage, @socket.io/redis-adapter and a shared presence store.',
      );
    }
  }

  // Every launched feature's required env vars must be present (see
  // src/launchedFeatures.ts). Currently only cinema declares any (Mux), and it
  // ships disabled — so this is a no-op until a feature with requiredEnv is
  // switched on.
  problems.push(...missingLaunchedFeatureEnv(config));

  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }

  return validated;
}
