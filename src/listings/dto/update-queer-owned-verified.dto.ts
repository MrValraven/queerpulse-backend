import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsCalendarDate } from './hours-exceptions.validator';

/**
 * `PATCH /admin/listings/:ref/queer-owned-verified` body — moderator/admin-only
 * (see `AdminListingsController`). Mirrors `UpdateSafeSpaceDto`'s shape,
 * because the two badges are meant to read as siblings on the page and are now
 * backed by the same kind of evidence.
 *
 * Every provenance field is optional so the existing one-field call
 * (`{ verified: true }`) keeps working, but none of them ends up blank: the
 * service fills the verifier from the acting moderator, dates the confirmation
 * today, and sets an expiry from `QUEER_OWNED_VERIFICATION_VALIDITY_MONTHS`.
 * A badge with no traceable provenance is what this replaced.
 */
export class UpdateQueerOwnedVerifiedDto {
  @IsBoolean()
  verified!: boolean;

  /** Who confirmed it, in `safeSpaceVerifier`'s free-text form
   * ("Mod team · company register"). Defaults to the acting moderator's name
   * when omitted. Ignored when `verified` is false. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  verifier?: string;

  /** When it was confirmed, `YYYY-MM-DD`. Defaults to today when omitted.
   * Strict, unlike the older `UpdateSafeSpaceDto.reVerifiedAt`, so the value
   * is always comparable against `expiresAt`. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsCalendarDate()
  reVerifiedAt?: string;

  /** What the confirmation rested on ("company register plus a call with the
   * owner"), sibling of `UpdateSafeSpaceDto.sub`. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  basis?: string;

  /** When the badge next needs re-confirming, `YYYY-MM-DD`. Defaults to
   * `QUEER_OWNED_VERIFICATION_VALIDITY_MONTHS` after the confirmation date.
   * Past this date the badge stops reading as verified in public responses
   * while the record of the grant stays intact. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsCalendarDate()
  expiresAt?: string;
}
