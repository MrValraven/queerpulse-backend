import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { STUDIO_PLAYLIST_FOLDER_LIMITS } from '../studio-playlist-folder.errors';
import { isPresentValue, trimStringValue } from './create-studio-release.dto';

/** `POST /studio/playlists/folders`. A blank name is refused. With
 *  `playlistId` ("Move to new folder") the playlist is filed in the new
 *  folder in the same request; a playlist that cannot be filed refuses the
 *  whole request, so no empty folder is left behind. */
export class CreateStudioPlaylistFolderDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_PLAYLIST_FOLDER_LIMITS.nameMaxLength)
  name!: string;

  @IsOptional()
  @IsUUID()
  playlistId?: string;
}

/** `PATCH /studio/playlists/folders/:folderId`. PATCH semantics: an absent
 *  field stays as it is and neither field takes null. `position` is the
 *  0-based index the folder moves to among the member's folders; past the
 *  end it lands last. */
export class UpdateStudioPlaylistFolderDto {
  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_PLAYLIST_FOLDER_LIMITS.nameMaxLength)
  name?: string;

  @ValidateIf(isPresentValue)
  @IsInt()
  @Min(0)
  @Max(STUDIO_PLAYLIST_FOLDER_LIMITS.foldersPerMember)
  position?: number;
}

/** `PUT /studio/playlists/:id/folder`. `folderId: null` takes the playlist
 *  out of its folder, back to the top level. */
export class MoveStudioPlaylistToFolderDto {
  @ValidateIf((_body: object, value: unknown) => value !== null)
  @IsUUID()
  folderId!: string | null;
}
