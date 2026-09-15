import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { ForumPostPhotoDto, MAX_POST_PHOTOS } from './forum-post-photo.dto';

// `POST /forum/threads/:slug/posts` body — `replyToThread(slug, body)` in
// the frontend's `forum.api.ts`.
export class ReplyThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  @IsOptional()
  @IsUUID()
  parentPostId?: string;

  // One optional photo on the reply, as a storage key from the presigned
  // upload pipeline (SOC-13). Same validator + global ownership interceptor as
  // `CreatePostDto.image`.
  @IsOptional()
  @IsImageReference()
  image?: string;

  // The same photo array the opening post takes (see `CreateThreadDto.photos`).
  //
  // A reply gets it because the RENDERING is shared: `toForumPostResponse` maps
  // the OP and every reply through one function, so a replies list that could
  // only ever draw one photo per row while the OP above it drew four would be a
  // difference in the client, not in the data. The same 400 applies when both
  // `image` and `photos` arrive non-empty.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_PHOTOS)
  @ValidateNested({ each: true })
  @Type(() => ForumPostPhotoDto)
  photos?: ForumPostPhotoDto[];
}
