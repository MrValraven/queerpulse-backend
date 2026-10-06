import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PLATFORM_LOG_CATEGORIES,
  PLATFORM_LOG_RANGES,
  type PlatformLogCategory,
  type PlatformLogRange,
} from '../platform-log.types';

/** Accepts `?categories=a&categories=b` and `?categories=a,b`. */
function toCategoryList(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const received: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : [value];
  const cleaned = received.flatMap((entry) =>
    typeof entry === 'string'
      ? entry.split(',').map((part) => part.trim())
      : [entry],
  );
  return [...new Set(cleaned.filter((entry) => entry !== ''))];
}

export class PlatformLogQuery {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => toCategoryList(value))
  @IsArray()
  @ArrayMaxSize(PLATFORM_LOG_CATEGORIES.length)
  @IsIn(PLATFORM_LOG_CATEGORIES as readonly string[], { each: true })
  categories?: PlatformLogCategory[];

  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsIn(PLATFORM_LOG_RANGES as readonly string[])
  range?: PlatformLogRange;
}
