import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { ForumPostPhotoDto, MAX_POST_PHOTOS } from './forum-post-photo.dto';

// `PATCH /forum/posts/:id` body — `editPost(id, body)` in the frontend's
// `forum.api.ts`. Same bounds as a reply body (`ReplyThreadDto`).
export class UpdateForumPostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  // Replacement photo for the post (SOC-13). Omitting the field leaves the
  // existing image untouched; an explicit empty string clears it — the same
  // "omitted means unchanged" contract `UpdateThreadDto.tags` uses, since a
  // JSON body cannot distinguish an absent optional from an explicit
  // `undefined`.
  @IsOptional()
  @IsImageReference()
  image?: string;

  // Replacement photo SET for the post, under exactly the contract `image`
  // above documents: omitting the field leaves the existing photos untouched,
  // and an explicit empty array clears them.
  //
  // "Clears them" means the post ends up with no photo at all, so a `photos: []`
  // also drops the legacy `image` column. Anything else would leave an
  // already-published single photo standing after the author asked for none,
  // since the read path presents that column as the gallery whenever there are
  // no `forum_post_photo` rows (see `toPostPhotoViews`). For the same reason a
  // NON-empty `photos` clears `image` too: the rows are then the whole gallery,
  // and a column nothing reads is a photo the author cannot delete.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_PHOTOS)
  @ValidateNested({ each: true })
  @Type(() => ForumPostPhotoDto)
  photos?: ForumPostPhotoDto[];
}
