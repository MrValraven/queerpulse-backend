import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body for `POST /community-posts/:id/replies` — the FE's `feed.api.ts`
 * sends `{ body }` (unlike the nested route's `ReplyDto`, whose field is
 * `text`); kept as its own DTO since `ValidationPipe`'s
 * `forbidNonWhitelisted: true` (see `src/main.ts`) would otherwise reject the
 * frontend's actual payload. */
export class FlatReplyDto {
  @IsString() @MinLength(1) @MaxLength(2000) body: string;
}
