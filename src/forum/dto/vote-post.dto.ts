import { IsIn, IsInt } from 'class-validator';

// `POST /forum/posts/:id/vote` body — `votePost(id, value)` in the
// frontend's `forum.api.ts`: "`value` is +1 / 0" (an upvote toggle, no
// downvote), so `IsIn` restricts to exactly those two values rather than a
// generic `@IsInt()` range.
export class VotePostDto {
  @IsInt()
  @IsIn([0, 1])
  value: number;
}
