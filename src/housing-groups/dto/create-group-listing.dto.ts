import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Group norms enforced as validation: a listing cannot be created without a
 * transparent price (`priceEuros`) and accessibility information
 * (`accessibilityInfo`). Both are `@Column`s WITHOUT `nullable: true`, so the
 * DB is the backstop even if a caller bypassed this DTO.
 */
export class CreateGroupListingDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(4000)
  description!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  neighbourhood!: string;

  // Price transparency is a norm — required, and a real number (no "ask me").
  @IsInt()
  @Min(1)
  priceEuros!: number;

  // Accessibility info is a norm — required and non-trivial.
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  accessibilityInfo!: string;
}
