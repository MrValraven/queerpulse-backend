import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

// Admin-only edit of an already-approved partner's marketing surface: the
// featured flag and the optional testimonial. All fields optional (PATCH
// semantics). A quote requires an author (enforced in the service), so both
// are validated as present-or-null here.
export class UpdatePartnerAdminDto {
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
