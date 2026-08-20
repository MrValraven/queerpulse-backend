import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ResourceGuideRating } from './entities/resource-guide-rating.entity';

export interface AdminGuideRatingAggregate {
  contentKey: string;
  helpfulCount: number;
  notHelpfulCount: number;
  /** helpfulCount / (helpfulCount + notHelpfulCount), 0..1. */
  ratio: number;
}

/**
 * Admin oversight of guide feedback (CNT-18, `Guide Feedback` admin page):
 * every rated guide's helpful/not-helpful split, sorted worst-ratio-first so
 * editors see failing guides first. Only content keys with at least one
 * rating appear — `GROUP BY` naturally excludes never-rated guides, which is
 * the desired "nothing to show yet" behaviour rather than a spurious 0/0 row.
 */
@Injectable()
export class AdminResourceGuideRatingsService {
  constructor(
    @InjectRepository(ResourceGuideRating)
    private readonly ratings: Repository<ResourceGuideRating>,
  ) {}

  async list(): Promise<AdminGuideRatingAggregate[]> {
    const rows = await this.ratings
      .createQueryBuilder('rating')
      .select('rating.contentKey', 'contentKey')
      .addSelect(
        `COUNT(*) FILTER (WHERE rating.value = 'helpful')`,
        'helpfulCount',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE rating.value = 'not_helpful')`,
        'notHelpfulCount',
      )
      .groupBy('rating.contentKey')
      .getRawMany<{
        contentKey: string;
        helpfulCount: string;
        notHelpfulCount: string;
      }>();

    return rows
      .map((row) => {
        const helpfulCount = Number(row.helpfulCount);
        const notHelpfulCount = Number(row.notHelpfulCount);
        const total = helpfulCount + notHelpfulCount;
        return {
          contentKey: row.contentKey,
          helpfulCount,
          notHelpfulCount,
          ratio: total === 0 ? 0 : helpfulCount / total,
        };
      })
      .sort(
        (a, b) =>
          a.ratio - b.ratio ||
          b.helpfulCount + b.notHelpfulCount - (a.helpfulCount + a.notHelpfulCount),
      );
  }
}
