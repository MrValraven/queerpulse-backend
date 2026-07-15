import { IsBoolean } from 'class-validator';

/** Body for `POST /community-posts/:id/like` — `liked` is the target state
 * (idempotent toggle), mirrored back in the response along with the
 * recomputed `likeCount`. */
export class LikePostDto {
  @IsBoolean() liked: boolean;
}
