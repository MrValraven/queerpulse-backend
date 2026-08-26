import {
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateGlossaryTermDto {
  @IsString()
  @MaxLength(120)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase words separated by single hyphens',
  })
  slug!: string;

  @IsString() @MaxLength(200) term!: string;

  @IsString() @MaxLength(4000) definition!: string;

  @IsOptional() @IsString() @MaxLength(4000) definitionPt?: string;

  /** Free-form category label, e.g. "Identity", "Healthcare", "Lisbon". */
  @IsOptional() @IsString() @MaxLength(120) category?: string;

  @IsOptional() @IsDateString() lastReviewedOn?: string;

  @IsOptional() @IsString() @MaxLength(120) reviewedBy?: string;

  @IsOptional() @IsDateString() reviewDueOn?: string;
}
