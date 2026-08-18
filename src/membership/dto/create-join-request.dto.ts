import {
  Equals,
  IsBoolean,
  IsEmail,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body of the PUBLIC `POST /join-requests`. Unauthenticated, so every field is
 * attacker-controlled and every one is length-capped — the message cap is part
 * of the spam story (throttle by IP + one open request per email + bounded
 * payload), not just hygiene.
 */
export class CreateJoinRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;

  /**
   * The email of a member already here who can vouch for the applicant. A
   * structured, matchable alternative to naming them inside `message` — a
   * reviewer can look this up directly instead of reading the whole message.
   * Optional: most applicants have nobody to name.
   */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  mutualMemberEmail?: string;

  /**
   * 18+ self-attestation (Terms §eligibility). Must be literally `true` — an
   * unattested request is refused rather than stored, mirroring
   * `AuthService.validateOrCreateGoogleUser`'s `age_attestation_required`.
   */
  @IsBoolean()
  @Equals(true)
  ageAttested!: true;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  termsVersion!: string;

  /**
   * The frontend entry point the applicant came through (e.g. `homepage_hero`,
   * `skills`). A soft attribution signal for the admin queue, not identity — so
   * it is length-capped rather than range-checked against a fixed list here: the
   * catalogue of CTAs lives on the frontend and grows without a backend change,
   * and an unrecognised key simply renders as "another page" in the queue. Empty
   * or omitted for a direct visit to the request page.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  /**
   * Optional date of birth (`YYYY-MM-DD`). When supplied it is checked against
   * the 18+ gate and a minor is rejected with 403 `UNDER_18`. Optional because
   * the attestation checkbox — not a DOB field — is the primary gate the
   * product uses; a DOB is simply a stronger signal when the frontend has one.
   */
  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;
}
