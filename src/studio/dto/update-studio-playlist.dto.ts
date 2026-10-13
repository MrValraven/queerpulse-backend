import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { StudioPlaylistVisibility } from '../entities/studio-playlist.entity';
import {
  STUDIO_LIMITS,
  STUDIO_PLAYLIST_VISIBILITIES,
} from '../studio.constants';
import { isPresentValue, trimStringValue } from './create-studio-release.dto';

// PATCH semantics: an absent field stays as it is. `name` and `visibility`
// refuse null (`ValidateIf` keeps validating it); `description` and
// `creditSubprofileId` take null to clear.
export class UpdateStudioPlaylistDto {
  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.playlistNameMaxLength)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.playlistDescriptionMaxLength)
  description?: string | null;

  @ValidateIf(isPresentValue)
  @IsIn(STUDIO_PLAYLIST_VISIBILITIES)
  visibility?: StudioPlaylistVisibility;

  @IsOptional()
  @IsUUID()
  creditSubprofileId?: string | null;
}
