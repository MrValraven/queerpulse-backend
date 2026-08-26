import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

// `POST /forum/threads` body — matches `CreateThreadDto` in the frontend's
// `forum.api.ts` (`title`, `body`, `category`, optional `tags`).
export class CreateThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  // `"all"` (any case) is reserved: `ThreadCategoryCounts` returns a flat
  // `{ all, ...perCategory }` map, so a category literally named `all` would
  // overwrite the total and corrupt the counts response. Reject it here so it
  // can never become a real category. (There is no `category` field on
  // `UpdateThreadDto`, so create is the only path a category is set.)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^(?!all$).+/i, { message: '"all" is a reserved category' })
  category!: string;

  // Up to 5 free-text tags, each ≤ 24 chars. The service normalizes them
  // (trim, lowercase, strip `#`, dedupe, drop empties) before persisting.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  tags?: string[];

  // One optional photo on the opening post, as a storage key from the
  // presigned upload pipeline (SOC-13). Same validator + global ownership
  // interceptor as `CreatePostDto.image`; persisted on the OP `forum_post`
  // row, not on the thread.
  @IsOptional()
  @IsImageReference()
  image?: string;

  // Optional community to attach this thread to. When present, the service
  // resolves it via `CommunityMembershipService.assertMemberBySlug` — 404 if
  // missing/archived, 403 if the author isn't on its roster — mirroring
  // `CreateEventDto.communitySlug`.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  communitySlug?: string;

  // Post this thread as "QueerPulse Official" instead of the caller. Only an
  // admin can actually set this — `ForumThreadsService.create` silently
  // coerces it to `false` for anyone else, since the composer only ever
  // shows the checkbox to admins.
  @IsOptional()
  @IsBoolean()
  isOfficial?: boolean;
}
