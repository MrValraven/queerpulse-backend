import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { StudioPlaylistVisibility } from '../entities/studio-playlist.entity';
import {
  STUDIO_LIMITS,
  STUDIO_PLAYLIST_VISIBILITIES,
} from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

export class CreateStudioPlaylistDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.playlistNameMaxLength)
  name!: string;

  /** An empty or blank description is stored as null. */
  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.playlistDescriptionMaxLength)
  description?: string | null;

  @IsIn(STUDIO_PLAYLIST_VISIBILITIES)
  visibility!: StudioPlaylistVisibility;

  /** "Show as": one of the caller's uploadable personas, or absent for the
   *  member. The service answers 422 for anything else. */
  @IsOptional()
  @IsUUID()
  creditSubprofileId?: string | null;
}
