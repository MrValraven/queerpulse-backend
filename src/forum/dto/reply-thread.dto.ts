import { IsString, MaxLength, MinLength } from 'class-validator';

// `POST /forum/threads/:slug/posts` body — `replyToThread(slug, body)` in
// the frontend's `forum.api.ts`.
export class ReplyThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body: string;
}
