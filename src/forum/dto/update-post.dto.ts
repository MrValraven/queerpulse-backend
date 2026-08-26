import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

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
}
