import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  GuideRatingValue,
  ResourceGuideRating,
} from './entities/resource-guide-rating.entity';

export interface GuideRatingResult {
  contentKey: string;
  helpfulCount: number;
  notHelpfulCount: number;
  myVote: GuideRatingValue | null;
}

// Guards `contentKey` against garbage/injection before it's stored or used in
// a WHERE clause — real content keys are i18n dot-paths like
// `legal.workplace.dismissal` or `sexualHealth.guides.hpvHepB`.
const CONTENT_KEY_PATTERN = /^[a-z0-9]+(\.[a-z0-9]+)*$/i;
const CONTENT_KEY_MAX_LENGTH = 200;

function assertValidContentKey(contentKey: string): void {
  if (
    contentKey.length === 0 ||
    contentKey.length > CONTENT_KEY_MAX_LENGTH ||
    !CONTENT_KEY_PATTERN.test(contentKey)
  ) {
    throw new BadRequestException('Malformed content key');
  }
}

interface RatingTallyRow {
  helpfulCount: string | number | null;
  notHelpfulCount: string | number | null;
}

/** `COUNT(*)` comes back as a bigint string from `pg`; `null` when no rows. */
function toCount(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Member-facing guide rating: upsert-toggle (CNT-18). One row per
 * `(contentKey, memberId)` — voting the same value again clears the row,
 * voting a different value changes it, matching `forum-post-vote.entity.ts`'s
 * toggle-vote UX.
 *
 * Both entry points used to `find({ where: { contentKey } })` — EVERY vote row
 * for the guide — and tally them in JS, which is O(votes) per read on the
 * exact sections that get the most votes. `rate()` also decided insert vs
 * update from that in-memory list, so two concurrent first votes from one
 * member both took the insert branch and the loser hit
 * `UQ_resource_guide_rating_content_key_member_id` as an uncaught 500 — a
 * plain double-click was enough.
 *
 * Now: the tally is one aggregate query (`COUNT(*) FILTER (WHERE …)`), and the
 * write is an `INSERT … ON CONFLICT (content_key, member_id) DO UPDATE`, so
 * the unique index resolves the race instead of raising on it. Clearing a vote
 * is still a plain delete — it is idempotent by nature.
 *
 * The reviewer also flagged "no index on `content_key` alone". That premise is
 * wrong: `content_key` is the LEADING column of the composite unique index, so
 * Postgres already uses it for a `WHERE content_key = $1` lookup. No extra
 * index is warranted.
 */
@Injectable()
export class ResourceGuideRatingsService {
  constructor(
    @InjectRepository(ResourceGuideRating)
    private readonly ratings: Repository<ResourceGuideRating>,
  ) {}

  async rate(
    contentKey: string,
    memberId: string,
    value: GuideRatingValue,
  ): Promise<GuideRatingResult> {
    assertValidContentKey(contentKey);

    // Read only THIS member's row, not the whole guide's votes, to decide
    // between "same value again -> clear" and "set/change".
    const existing = await this.ratings.findOne({
      where: { contentKey, memberId },
    });

    let myVote: GuideRatingValue | null;
    if (existing && existing.value === value) {
      await this.ratings.delete({ contentKey, memberId });
      myVote = null;
    } else {
      // `upsert` compiles to INSERT ... ON CONFLICT DO UPDATE, so a concurrent
      // first vote from the same member converges on one row instead of
      // raising a unique violation.
      await this.ratings.upsert(
        { contentKey, memberId, value },
        {
          conflictPaths: ['contentKey', 'memberId'],
          skipUpdateIfNoValuesChanged: true,
        },
      );
      myVote = value;
    }

    return this.tally(contentKey, myVote);
  }

  async getForContentKey(
    contentKey: string,
    memberId: string,
  ): Promise<GuideRatingResult> {
    assertValidContentKey(contentKey);
    const mine = await this.ratings.findOne({
      where: { contentKey, memberId },
    });
    return this.tally(contentKey, mine?.value ?? null);
  }

  /**
   * Both counts in one aggregate pass over the index, instead of shipping
   * every vote row to the app to be counted there.
   */
  private async tally(
    contentKey: string,
    myVote: GuideRatingValue | null,
  ): Promise<GuideRatingResult> {
    const row = await this.ratings
      .createQueryBuilder('rating')
      .select(
        "COUNT(*) FILTER (WHERE rating.value = 'helpful')",
        'helpfulCount',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE rating.value = 'not_helpful')",
        'notHelpfulCount',
      )
      .where('rating.contentKey = :contentKey', { contentKey })
      .getRawOne<RatingTallyRow>();

    return {
      contentKey,
      helpfulCount: toCount(row?.helpfulCount ?? null),
      notHelpfulCount: toCount(row?.notHelpfulCount ?? null),
      myVote,
    };
  }
}
