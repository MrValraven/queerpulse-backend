import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import {
  SubprofileLinkVisibility,
  SubprofileVisibility,
  type SkinData,
} from '../entities/subprofile.entity';
import {
  ACCENT_KEYS,
  AVAILABILITY_KEYS,
  MAX_CTA_LABEL,
} from '../subprofile-validation';

// All fields optional (PATCH semantics). Field names match GLOBAL CONTRACT C4.
// `@IsOptional()` treats both `undefined` and `null` as "skip", so nullable
// fields (avatarUrl/tagline/bio) accept `null` to clear them. The desired
// `handle` is stored as-is here and only fully validated on publish (spec §4).
export class UpdateSubprofileDTO {
  // Trimmed before validation so a whitespace-only name (`"   "`) is a
  // field-level 400 (`@MinLength(1)`) rather than slipping through as a blank
  // display name. `@IsOptional()` still skips an omitted field (PATCH).
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120) slug?: string;

  @IsOptional() @IsString() @MaxLength(30) handle?: string;

  @IsOptional() @IsImageReference() avatarUrl?: string | null;

  @IsOptional() @IsString() @MaxLength(200) tagline?: string | null;

  @IsOptional() @IsString() @MaxLength(5000) bio?: string | null;

  @IsOptional()
  @IsEnum(SubprofileLinkVisibility)
  linkVisibility?: SubprofileLinkVisibility;

  @IsOptional() @IsEnum(SubprofileVisibility) visibility?: SubprofileVisibility;

  @IsOptional() @IsInt() @Min(0) position?: number;

  @IsOptional() @IsImageReference() coverUrl?: string | null;

  @IsOptional()
  @IsIn([...ACCENT_KEYS, null])
  accent?: string | null;

  @IsOptional()
  @IsIn([...AVAILABILITY_KEYS, null])
  availability?: string | null;

  @IsOptional() @IsString() @MaxLength(MAX_CTA_LABEL) ctaLabel?: string | null;

  @IsOptional() @IsString() @MaxLength(1000) @IsSafeUrl() ctaUrl?:
    string | null;

  // Personas redesign Phase 0 (design plan "Shared Contract"). Shape-checked
  // here with a 16 KB serialized-size cap enforced in
  // `SubprofilesService.assertJsonbSize` before persisting.
  @IsOptional() @IsObject() skinData?: SkinData;
}
