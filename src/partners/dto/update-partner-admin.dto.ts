import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { UpdatePartnerProfileDto } from './update-partner-profile.dto';

/**
 * Staff edit of an already-approved partner (PRD-263).
 *
 * EXTENDS the owner's profile DTO rather than repeating it: staff can change
 * everything a partner can change about itself, plus the fields that are
 * QueerPulse's to set. class-validator applies inherited decorators, so the
 * parent's rules hold here unchanged and the two paths can never drift into
 * validating the same field differently.
 *
 * Before this, the staff console could only reach `featured` and the
 * testimonial trio, while `tier`, `since` and `eyebrow` were written once from
 * form defaults at submission and then frozen — so every partner showed the
 * same default tier, and a partner whose phone number changed kept the wrong
 * one until somebody edited the row by hand.
 *
 * All fields optional (PATCH semantics). A quote requires an author, enforced
 * in the service, so both are validated as present-or-null here.
 */
export class UpdatePartnerAdminDto extends UpdatePartnerProfileDto {
  /** The identity the approval was granted to; the slug does NOT follow a
   *  rename, so inbound links survive. Staff-only for that reason. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  /** The partnership's grade ("Founding partner", "Health partner"). A claim
   *  about the relationship, so it is never self-declared. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) tier?: string;

  /** When the partnership started, as it prints on the card. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) since?: string;

  /** The card kicker, which reads "Partner · <type>" — its first word is a
   *  relationship claim, so it stays on this side of the line. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) eyebrow?: string;

  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(600)
  testimonialQuote?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(160)
  testimonialAuthor?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(160)
  testimonialRole?: string | null;
}
