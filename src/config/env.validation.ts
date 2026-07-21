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
  NODE_ENV: NodeEnv;

  // Optional so the `?? 3000` fallbacks in app.config/main are reachable rather
  // than dead code. Platforms that inject PORT (Railway, Heroku) still win.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET: string;

  @IsString()
  GOOGLE_CLIENT_ID: string;

  @IsString()
  GOOGLE_CLIENT_SECRET: string;

  @IsString()
  GOOGLE_CALLBACK_URL: string;

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

  @IsOptional()
  @IsNumber()
  @Min(0)
  INVITE_MONTHLY_QUOTA?: number;

  // Optional because it is absent in every environment except during one-time
  // founder bootstrap — absence is the normal, safe state, and it is what makes
  // the genesis endpoints 404.
  @IsOptional()
  @IsEmail()
  GENESIS_EMAIL?: string;
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
