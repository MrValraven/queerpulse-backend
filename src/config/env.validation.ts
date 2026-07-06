import { plainToInstance } from 'class-transformer';
import {
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

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv;

  @IsNumber()
  @Min(0)
  @Max(65535)
  PORT: number;

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

  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  @IsOptional()
  @IsString()
  LOG_LEVEL?: string;

  @IsOptional() @IsString() S3_ENDPOINT?: string;
  @IsOptional() @IsString() S3_REGION?: string;
  @IsOptional() @IsString() S3_BUCKET?: string;
  @IsOptional() @IsString() S3_ACCESS_KEY?: string;
  @IsOptional() @IsString() S3_SECRET_KEY?: string;
  @IsOptional() @IsString() S3_PUBLIC_URL?: string;

  @IsOptional() @IsString() MUX_TOKEN_ID?: string;
  @IsOptional() @IsString() MUX_TOKEN_SECRET?: string;
  @IsOptional() @IsString() MUX_WEBHOOK_SECRET?: string;
  @IsOptional() @IsString() MUX_SIGNING_KEY_ID?: string;
  @IsOptional() @IsString() MUX_SIGNING_PRIVATE_KEY?: string;

  @IsOptional()
  @IsNumber()
  VOUCH_THRESHOLD?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  INVITE_MONTHLY_QUOTA?: number;
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
  problems.push(
    ...missingLaunchedFeatureEnv(config as Record<string, unknown>),
  );

  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }

  return validated;
}
