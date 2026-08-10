import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  SAFE_SPACE_VOUCH_RELATIONSHIPS,
  type SafeSpaceVouchRelationship,
} from '../entities/safe-space-vouch.entity';

/**
 * Body for `POST /safe-spaces/:slug/vouch`. Mirrors the member-vouch
 * `CreateVouchDto` shape ({ note?, relationship?, anonymous? }). Every field is
 * optional — a member can vouch on relationship alone. The global
 * `ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`, so any extra key
 * is rejected.
 */
export class CreateSafeSpaceVouchDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsIn(SAFE_SPACE_VOUCH_RELATIONSHIPS)
  relationship?: SafeSpaceVouchRelationship;

  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;
}
