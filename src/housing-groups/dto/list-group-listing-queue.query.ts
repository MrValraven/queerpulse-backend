import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { GroupListingStatus } from '../entities/group-listing.entity';

/**
 * `GET /admin/housing-groups/listings/queue` — the paginated review queue a
 * moderator actually works from (LOC-19).
 *
 * Distinct from the pre-existing `GET /admin/housing-groups/listings`, which
 * returns one uncapped-by-page slab of every listing ever posted, riskiest
 * first, and has no way to ask "what is still waiting on me". That endpoint is
 * untouched — its caller is `AdminHousingGroupsController` and its shape is
 * already relied on.
 */
export class ListGroupListingQueueQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // The queue filter the console opens on: `?status=review` is "what still
  // needs a decision". Omitted means every state.
  @IsOptional()
  @IsEnum(GroupListingStatus)
  status?: GroupListingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  group?: string;

  // Narrow to (or exclude) post-publication takedowns. Separate from `status`
  // on purpose: `hidden` and `status` are two independent moderation controls
  // on the same row and must never be collapsed into one axis.
  //
  // `@Type(() => Boolean)` would be wrong here: `Boolean('false')` is `true`,
  // so an explicit `?hidden=false` would filter for hidden listings. The
  // string comparison is the same one `browse-housing-listings.query.ts` uses.
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hidden?: boolean;
}
