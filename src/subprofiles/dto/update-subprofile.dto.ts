import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  SubprofileLinkVisibility,
  SubprofileVisibility,
} from '../entities/subprofile.entity';

// All fields optional (PATCH semantics). Field names match GLOBAL CONTRACT C4.
// `@IsOptional()` treats both `undefined` and `null` as "skip", so nullable
// fields (avatarUrl/tagline/bio) accept `null` to clear them. The desired
// `handle` is stored as-is here and only fully validated on publish (spec §4).
export class UpdateSubprofileDTO {
  @IsOptional() @IsString() @MaxLength(120) displayName?: string;

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
}
