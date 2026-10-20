import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import { StudioReleaseType } from '../entities/studio-release.entity';
import {
  STUDIO_GENRES,
  STUDIO_LIMITS,
  STUDIO_MOODS,
  STUDIO_RELEASE_TYPES,
  StudioGenre,
  StudioMood,
} from '../studio.constants';
import { isPresentValue, trimStringValue } from './create-studio-release.dto';

// PATCH semantics: an absent field stays as it is. `title` and `type` refuse
// null (`ValidateIf` keeps validating it); the nullable fields take null to
// clear (`IsOptional` skips null and undefined).
export class UpdateStudioReleaseDto {
  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.releaseTitleMaxLength)
  title?: string;

  @ValidateIf(isPresentValue)
  @IsIn(STUDIO_RELEASE_TYPES)
  type?: StudioReleaseType;

  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.releaseDescriptionMaxLength)
  description?: string | null;

  @IsOptional()
  @IsIn(STUDIO_GENRES)
  genre?: StudioGenre | null;

  /** Studio discovery: one of `STUDIO_MOODS`; null clears. */
  @IsOptional()
  @IsIn(STUDIO_MOODS)
  mood?: StudioMood | null;

  /** Studio discovery: an active scene; null leaves the current one. The
   *  release's own scene stays accepted after it is archived. */
  @IsOptional()
  @IsUUID()
  sceneId?: string | null;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  releasedOn?: string | null;

  // From the existing persona image presign. The service copies it to a
  // persona-scoped key; `StorageKeyOwnershipInterceptor` lets this handler
  // carry a persona-scoped key (`PERSONA_SCOPED_KEY_HANDLERS`).
  @IsOptional()
  @IsImageReference()
  coverKey?: string | null;

  @IsOptional()
  @Equals(true)
  rightsConfirmed?: true;

  // Studio v3: "Buy link" on the release step. Outbound only; nothing
  // counts a click. `null` clears.
  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.buyUrlMaxLength)
  @IsSafeUrl()
  @Matches(/^https:\/\//i, { message: 'buyUrl must be an https link' })
  buyUrl?: string | null;

  /** Studio listening: "Play without gaps" on the release step; null is
   *  refused. */
  @ValidateIf(isPresentValue)
  @IsBoolean()
  isGapless?: boolean;
}
