import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SAFE_SPACE_FLAG_REASONS,
  SAFE_SPACE_FLAG_RESOLUTIONS,
  type SafeSpaceFlagReason,
  type SafeSpaceFlagResolution,
} from '../entities/safe-space-flag.entity';

/**
 * Body of `POST /safe-spaces/:slug/flag`.
 *
 * `reasonCode` is a closed set so the moderation queue can group and count
 * without reading anyone's prose. `detail` is the member's own words and is
 * moderator-only: it never reaches the venue owner and never reaches any
 * public response.
 */
export class CreateSafeSpaceFlagDto {
  @IsIn(SAFE_SPACE_FLAG_REASONS)
  reasonCode!: SafeSpaceFlagReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string;
}

/** Body of `POST /admin/safe-space-flags/:id/resolve`. */
export class ResolveSafeSpaceFlagDto {
  @IsIn(SAFE_SPACE_FLAG_RESOLUTIONS)
  resolution!: SafeSpaceFlagResolution;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Body of `POST /admin/safe-spaces/:ref/badge/suspend`. */
export class SuspendSafeSpaceBadgeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

/** Body of `POST /admin/safe-spaces/:ref/badge/restore`. */
export class RestoreSafeSpaceBadgeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

export const ADMIN_FLAG_STATES = ['open', 'resolved', 'all'] as const;
export type AdminFlagState = (typeof ADMIN_FLAG_STATES)[number];

/** Filters for `GET /admin/safe-space-flags`. */
export class AdminFlagsQuery {
  @IsOptional()
  @IsIn(ADMIN_FLAG_STATES)
  state?: AdminFlagState;

  @IsOptional()
  @IsIn(SAFE_SPACE_FLAG_REASONS)
  reasonCode?: SafeSpaceFlagReason;

  /** Narrow to one business, by its listing `ref` or `slug`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  listingRef?: string;

  /** Only spaces whose badge is currently suspended. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  suspendedOnly?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
