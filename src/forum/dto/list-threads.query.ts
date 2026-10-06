import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  FUNDING_ELIGIBILITIES,
  FUNDING_SCOPES,
  FUNDING_VIEWS,
} from '../forum-funding';
import type {
  FundingEligibility,
  FundingScope,
  FundingView,
} from '../forum-funding';

// `GET /forum/threads?category=&cursor=&sort=&tag=&q=` query.
export class ListThreadsQuery {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Ordering of the page. `active` (the DEFAULT when omitted) →
  // most-recently-active; `new` → newest-first by `(createdAt, id)`; `top` →
  // highest OP vote count among threads from the last 30 days, tie-broken by
  // recency, falling back to the whole forum when the window is near-empty;
  // `unanswered` → newest-first among threads with no accepted answer. The
  // service applies the sort; validated here so an unknown value is rejected up
  // front.
  @IsOptional()
  @IsIn(['new', 'top', 'active', 'unanswered'])
  sort?: 'new' | 'top' | 'active' | 'unanswered';

  // Single tag filter — matched against the thread's normalized `tags` array.
  @IsOptional()
  @IsString()
  tag?: string;

  // Free-text search (accent-folded LIKE) over the thread title OR the body of
  // any visible post in the thread, folded into the list query. See
  // `ForumThreadsService.applyTextAndTagFilters`.
  @IsOptional()
  @IsString()
  q?: string;

  // Funding & Grants views, honoured only with `category=funding`
  // (`ForumThreadsService.list`): `open` and `closing` list calls by
  // deadline, `asks` lists live fundraisers, `discussion` lists the threads
  // with no funding details.
  @IsOptional()
  @IsIn(FUNDING_VIEWS)
  fundingView?: FundingView;

  // Any-of eligibility filter for the call views. `?eligibility=students` and
  // `?eligibility=students&eligibility=collectives` both arrive here; the
  // scalar case is coerced to a list, as `BrowseHousingListingsQuery.areas`
  // does.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @ArrayMaxSize(FUNDING_ELIGIBILITIES.length)
  @IsIn(FUNDING_ELIGIBILITIES, { each: true })
  eligibility?: FundingEligibility[];

  // Scope filter for the call views.
  @IsOptional()
  @IsIn(FUNDING_SCOPES)
  scope?: FundingScope;
}
