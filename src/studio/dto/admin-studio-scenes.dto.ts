import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  STUDIO_DISCOVERY_LIMITS,
  STUDIO_SCENE_SLUG_PATTERN,
} from '../studio.constants';
import { isPresentValue, trimStringValue } from './create-studio-release.dto';

export class CreateAdminStudioSceneDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_DISCOVERY_LIMITS.sceneNameMaxLength)
  name!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_DISCOVERY_LIMITS.sceneCityMaxLength)
  city!: string;

  /** Left out, the server builds it from the name. */
  @IsOptional()
  @IsString()
  @Length(
    STUDIO_DISCOVERY_LIMITS.sceneSlugMinLength,
    STUDIO_DISCOVERY_LIMITS.sceneSlugMaxLength,
  )
  @Matches(STUDIO_SCENE_SLUG_PATTERN)
  slug?: string;

  /** Trimmed; the service stores an empty blurb as null. */
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.sceneBlurbMaxLength)
  blurb?: string | null;

  /** A `work-image` upload key from the admin's own presign. */
  @IsOptional()
  @IsImageReference()
  coverKey?: string | null;
}

// PATCH semantics: an absent field stays as it is. `name`, `city` and
// `slug` refuse null; the nullable fields take null to clear.
export class UpdateAdminStudioSceneDto {
  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_DISCOVERY_LIMITS.sceneNameMaxLength)
  name?: string;

  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_DISCOVERY_LIMITS.sceneCityMaxLength)
  city?: string;

  @ValidateIf(isPresentValue)
  @IsString()
  @Length(
    STUDIO_DISCOVERY_LIMITS.sceneSlugMinLength,
    STUDIO_DISCOVERY_LIMITS.sceneSlugMaxLength,
  )
  @Matches(STUDIO_SCENE_SLUG_PATTERN)
  slug?: string;

  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_DISCOVERY_LIMITS.sceneBlurbMaxLength)
  blurb?: string | null;

  @IsOptional()
  @IsImageReference()
  coverKey?: string | null;
}

export class ReorderAdminStudioScenesDto {
  /** Every active scene exactly once, in the new order. */
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  sceneIds!: string[];
}

export class PinAdminStudioSceneEventDto {
  @IsUUID()
  eventId!: string;
}
