import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

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
}
