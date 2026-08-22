import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SafeSpaceStatus } from '../entities/listing.entity';

class SafeSpacePromiseInput {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(1000) desc!: string;
}

class SafeSpaceVouchInput {
  @IsString() @MaxLength(200) name!: string;
  @IsString() @MaxLength(200) byline!: string;
  @IsString() @MaxLength(2000) text!: string;
  @IsString() @MaxLength(100) when!: string;
}

/** `PATCH /listings/:ref/safe-space` body — moderator/admin-only (see
 * `ListingsController`). `reason` is the only removal-narrative field the
 * admin UI collects; the service composes the rest of `safeSpaceRemoval`
 * from it, preserving any existing sub-fields (seed-populated for now). */
export class UpdateSafeSpaceDto {
  @IsEnum(SafeSpaceStatus)
  status!: SafeSpaceStatus;

  // Seeded tiers run 1-3 and 0 renders the tier-less banner variant; the
  // ceiling is deliberately loose because the tier ladder is a moderation
  // policy that may grow, not a closed enum.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  tier?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  verifier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reVerifiedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  sub?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SafeSpacePromiseInput)
  promises?: SafeSpacePromiseInput[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SafeSpaceVouchInput)
  vouches?: SafeSpaceVouchInput[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
