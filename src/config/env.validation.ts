import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

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
  JWT_ACCESS_SECRET: string;

  @IsString()
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
  return validated;
}
