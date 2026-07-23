import { IsString, MaxLength, MinLength } from 'class-validator';

// `PATCH /forum/posts/:id` body — `editPost(id, body)` in the frontend's
// `forum.api.ts`. Same bounds as a reply body (`ReplyThreadDto`).
export class UpdatePostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body: string;
}
