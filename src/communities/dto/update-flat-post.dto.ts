import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { PostKind } from '../entities/community-post.entity';

/**
 * Body for `PATCH /community-posts/:id` — the flat alias's own update DTO
 * (`CommunityPostsController.update` / `CommunityPostsService.updateFlatPost`).
 * Author-only; deliberately omits `pinned` (`UpdatePostDto`'s moderator-only
 * field, see that DTO's doc comment) since a flat/global post has no
 * community to pin *within*.
 */
export class UpdateFlatPostDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(5000) body?: string;
  @IsOptional() @IsEnum(PostKind) kind?: PostKind;
  // `@IsOptional` treats `null`/`''` as "skip", so both clear the image back
  // to none — same contract as `UpdatePostDto.image`.
  @IsOptional() @IsImageReference() image?: string | null;
}
