import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';

/**
 * `POST /studio/playlists/:id/editors`: the owner invites connections to a
 * member-credited playlist, or picks co-owners for a persona-credited one.
 * Members are addressed by profile slug, like every member-addressing
 * route. All or nothing.
 */
export class AddStudioPlaylistEditorsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_LIMITS.playlistEditorsMax)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(STUDIO_LIMITS.playlistEditorSlugMaxLength, { each: true })
  memberSlugs!: string[];
}
