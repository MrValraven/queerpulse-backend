import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// `PATCH /forum/threads/:slug` body — an optional `title`, `tags` replacement
// and `category` move, each carrying its own permission in the service (see
// `ForumThreadsService.updateThread`).
export class UpdateThreadDto {
  // Optional since SOC-13: the tag editor patches `{ tags }` alone, and a
  // moderator filing someone else's thread must not have to resend (and so
  // re-stamp an edit revision on) a title they are not changing. Omitting it
  // leaves the title untouched; the service still refuses a title edit from
  // anyone but the author.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  // Replacement tag set (up to 5, each ≤ 24 chars). Normalized by the service
  // (trim, lowercase, strip `#`, dedupe, drop empties) before persisting.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  tags?: string[];

  // Move the thread to another category (C8/PRD-163). A thread's category used
  // to be fixed at creation with nothing able to change it, so a trans-health
  // question filed under "General" stayed invisible to everyone filtering for
  // it and the only remedy was to delete and repost, losing the replies.
  //
  // Validated with EXACTLY the rules `CreateThreadDto.category` carries, since
  // this is now the second path that can set the column and a rule enforced on
  // only one of them is not enforced. `"all"` stays reserved for the same reason
  // it is there: `ThreadCategoryCounts` is a flat `{ all, ...perCategory }` map,
  // so a category literally named `all` would overwrite the total.
  //
  // WHO may send it is the service's call, not the DTO's: the author within the
  // thread's first 24 hours, a moderator at any time.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^(?!all$).+/i, { message: '"all" is a reserved category' })
  category?: string;
}
