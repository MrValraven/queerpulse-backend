import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsUUID,
} from 'class-validator';
import { STUDIO_PROFILE_PLAYLISTS_MAX_FEATURED } from '../entities/studio-profile-playlist-setting.entity';

/** `PUT /studio/me/profile-playlists`: the whole setting, replaced. */
export class UpdateStudioProfilePlaylistsDto {
  @IsBoolean()
  isShown!: boolean;

  @IsArray()
  @ArrayMaxSize(STUDIO_PROFILE_PLAYLISTS_MAX_FEATURED)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  featuredIds!: string[];
}
