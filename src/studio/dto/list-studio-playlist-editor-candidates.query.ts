import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `GET /studio/playlists/:id/editor-candidates?q=`. An empty `q` lists
 *  every candidate. */
export class ListStudioPlaylistEditorCandidatesQuery {
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_LIMITS.playlistEditorSearchMaxLength)
  q?: string;
}
