import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { CommunityListFilter, CommunityListSort } from '../communities.service';
import { LANGUAGE_CODES } from '../../profiles/languages';
import { AccessTier, CommunityType } from '../entities/community.entity';

/**
 * Tri-state query-string boolean: `?online=true` narrows to online
 * communities, `?online=false` narrows to the ones that meet in person, and an
 * absent (or unrecognised) value applies no filter at all. The broader
 * `value === 'true'` idiom used elsewhere in this repo collapses "false" and
 * "absent" into the same answer, which is wrong for a filter that has to be
 * able to express both sides.
 */
function toOptionalQueryBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

export class ListCommunitiesQuery {
  @IsOptional()
  @IsIn(['discover', 'mine'])
  filter?: CommunityListFilter;

  @IsOptional()
  @IsEnum(CommunityType)
  type?: CommunityType;

  @IsOptional()
  @IsEnum(AccessTier)
  access?: AccessTier;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // Free-text search over name/tagline/purpose, ANDed with the filters above
  // (see `CommunitiesService.list`'s `q` handling) rather than replacing
  // them.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q?: string;

  // Defaults to 'newest' (current `created_at DESC` behavior) when omitted,
  // backward compatible with every existing caller. 'active' orders by the
  // denormalised, indexed, hourly-refreshed `communities.active_this_week`
  // counter, which is what lets Discover's "Most active" and "Busy this week"
  // be a paginated server-side sort instead of the client draining every page
  // to count for itself.
  @IsOptional()
  @IsIn(['newest', 'name', 'active'])
  sort?: CommunityListSort;

  // Exact (case-insensitive) match on `communities.city`.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  city?: string;

  // One language code from the shared vocabulary (`src/profiles/languages.ts`).
  // Matches when the community's `languages` array CONTAINS it, via the array
  // overlap operator the `tags` filter already uses.
  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  language?: string;

  // `?online=true` / `?online=false`; omitted means no filter. See
  // `toOptionalQueryBoolean`.
  @IsOptional()
  @Transform(({ value }) => toOptionalQueryBoolean(value))
  @IsBoolean()
  online?: boolean;

  // Comma-separated curated tag ids, e.g. ?tags=trans-nonbinary,book-club.
  // Filters `communities.tags`; see `CommunitiesService.list` and
  // `src/communities/community-tags.ts` for the accepted vocabulary.
  @IsOptional()
  @IsString()
  tags?: string;
}
