import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { SafeSpaceStatus } from '../entities/listing.entity';

class SafeSpacePromiseInput {
  @IsString() title: string;
  @IsString() desc: string;
}

class SafeSpaceVouchInput {
  @IsString() name: string;
  @IsString() byline: string;
  @IsString() text: string;
  @IsString() when: string;
}

/** `PATCH /listings/:ref/safe-space` body — moderator/admin-only (see
 * `ListingsController`). `reason` is the only removal-narrative field the
 * admin UI collects; the service composes the rest of `safeSpaceRemoval`
 * from it, preserving any existing sub-fields (seed-populated for now). */
export class UpdateSafeSpaceDto {
  @IsEnum(SafeSpaceStatus)
  status: SafeSpaceStatus;

  @IsOptional()
  @IsInt()
  tier?: number;

  @IsOptional()
  @IsString()
  verifier?: string;

  @IsOptional()
  @IsString()
  reVerifiedAt?: string;

  @IsOptional()
  @IsString()
  sub?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SafeSpacePromiseInput)
  promises?: SafeSpacePromiseInput[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SafeSpaceVouchInput)
  vouches?: SafeSpaceVouchInput[];

  @IsOptional()
  @IsString()
  reason?: string;
}
