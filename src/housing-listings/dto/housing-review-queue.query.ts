import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { HousingListingStatus } from '../entities/housing-listing.entity';

/**
 * How the review queue is ordered.
 *
 * `risk` is the DEFAULT and the reason the queue exists: `housing-risk.ts`
 * already scores every listing deterministically at create and on every edit,
 * so leading with the highest score puts the likely scam, the likely
 * discriminatory listing and the unverified lister in front of the moderator
 * first. Ties break on oldest-first so nothing at a given score can be starved.
 *
 * `oldest` is the fairness view (nothing waits forever) and `newest` is the
 * "what just came in" view.
 */
export enum HousingReviewQueueSort {
  Risk = 'risk',
  Oldest = 'oldest',
  Newest = 'newest',
}

/** `?status=all` widens the queue to every status at once. */
export const HOUSING_REVIEW_QUEUE_STATUS_ALL = 'all';

export type HousingReviewQueueStatus =
  HousingListingStatus | typeof HOUSING_REVIEW_QUEUE_STATUS_ALL;

/**
 * GET /admin/housing-listings query. Every parameter is optional; the bare
 * endpoint returns the PENDING queue (`status=review`) sorted riskiest-first,
 * which is the moderator's actual working set.
 */
export class HousingReviewQueueQuery {
  /**
   * Which bucket to list. Defaults to `review`. Pass `all` for every listing
   * regardless of status (the old unfiltered `GET /admin/housing-listings`
   * behaviour, kept reachable so nothing that depended on it is orphaned).
   */
  @IsOptional()
  @IsEnum(
    {
      ...HousingListingStatus,
      All: HOUSING_REVIEW_QUEUE_STATUS_ALL,
    },
    {
      message:
        'status must be one of review, question, live, rejected, taken_down, all',
    },
  )
  status?: HousingReviewQueueStatus;

  @IsOptional() @IsEnum(HousingReviewQueueSort) sort?: HousingReviewQueueSort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
