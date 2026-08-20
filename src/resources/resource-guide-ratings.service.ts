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

function toResult(
  contentKey: string,
  rows: ResourceGuideRating[],
  myVote: GuideRatingValue | null,
): GuideRatingResult {
  return {
    contentKey,
    helpfulCount: rows.filter((r) => r.value === 'helpful').length,
    notHelpfulCount: rows.filter((r) => r.value === 'not_helpful').length,
    myVote,
  };
}

/**
 * Member-facing guide rating: upsert-toggle (CNT-18). One row per
 * `(contentKey, memberId)` — voting the same value again clears the row,
 * voting a different value changes it, matching `forum-post-vote.entity.ts`'s
 * toggle-vote UX. Small, low-contention feature (one rating per member per
 * guide, cast rarely) — the find-then-write below is not wrapped in a
 * transaction the way `ForumPostsService.vote()` is; a genuine concurrent
 * double-submit from the same member would surface as a unique-constraint
 * violation on the create branch, which the caller can just retry.
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
    const rows = await this.ratings.find({ where: { contentKey } });
    const existing = rows.find((r) => r.memberId === memberId);

    let myVote: GuideRatingValue | null;
    if (existing && existing.value === value) {
      await this.ratings.delete({ id: existing.id });
      rows.splice(rows.indexOf(existing), 1);
      myVote = null;
    } else if (existing) {
      existing.value = value;
      await this.ratings.save(existing);
      myVote = value;
    } else {
      const created = await this.ratings.save(
        this.ratings.create({ contentKey, memberId, value }),
      );
      rows.push(created);
      myVote = value;
    }

    return toResult(contentKey, rows, myVote);
  }

  async getForContentKey(
    contentKey: string,
    memberId: string,
  ): Promise<GuideRatingResult> {
    assertValidContentKey(contentKey);
    const rows = await this.ratings.find({ where: { contentKey } });
    const mine = rows.find((r) => r.memberId === memberId);
    return toResult(contentKey, rows, mine?.value ?? null);
  }
}
