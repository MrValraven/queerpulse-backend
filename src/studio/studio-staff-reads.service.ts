import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import {
  StudioAdminDispute,
  StudioAdminWithdrawnRelease,
  toStudioAdminDispute,
} from './studio-dispute-response';
import { StudioPage } from './studio-response';
import { STUDIO_LIMITS } from './studio.constants';

interface OpenDisputeRow {
  release_id: string;
  dispute_id: string;
}

/**
 * Studio open demo pages (sections 5.2 and 7.1): the staff flag review's
 * Disputes and Withdrawn tabs. Both page 20 at a time, newest first, with
 * the Studio cursor (`encodeStudioCursor`, whose time slot holds each
 * list's own sort column: the dispute's `created_at`, the release's
 * `taken_down_at`, both written at millisecond precision). Release cards
 * come from `StudioCatalogService.staffSummariesByReleaseId`, which names
 * the persona and never the member who runs it.
 */
@Injectable()
export class StudioStaffReadsService {
  constructor(
    @InjectRepository(StudioReleaseDispute)
    private readonly disputes: Repository<StudioReleaseDispute>,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    private readonly catalog: StudioCatalogService,
  ) {}

  async listDisputes(
    status: StudioReleaseDisputeStatus,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioAdminDispute>> {
    const pageSize = STUDIO_LIMITS.staffItemsPerPage;
    const queryBuilder = this.disputes
      .createQueryBuilder('dispute')
      .where('dispute.status = :disputeStatus', { disputeStatus: status });
    const decodedCursor = decodeStudioCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("dispute"."created_at", "dispute"."id") < (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await queryBuilder
      .orderBy('dispute.createdAt', 'DESC')
      .addOrderBy('dispute.id', 'DESC')
      .limit(pageSize + 1)
      .getMany();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const summaries = await this.catalog.staffSummariesByReleaseId([
      ...new Set(pageRows.map((dispute) => dispute.releaseId)),
    ]);
    const lastDispute = pageRows[pageRows.length - 1];
    return {
      // A dispute whose release went (deleted with its persona) drops out.
      items: pageRows.flatMap((dispute) => {
        const releaseSummary = summaries.get(dispute.releaseId);
        return releaseSummary
          ? [toStudioAdminDispute(dispute, releaseSummary)]
          : [];
      }),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastDispute
            ? encodeStudioCursor({
                publishedAt: lastDispute.createdAt,
                id: lastDispute.id,
              })
            : null,
      },
    };
  }

  async listWithdrawn(
    cursor: string | undefined,
  ): Promise<StudioPage<StudioAdminWithdrawnRelease>> {
    const pageSize = STUDIO_LIMITS.staffItemsPerPage;
    const queryBuilder = this.releases
      .createQueryBuilder('release')
      .select(['release.id', 'release.takenDownAt'])
      .where('release.status = :takenDownStatus', {
        takenDownStatus: StudioReleaseStatus.TakenDown,
      })
      .andWhere('"release"."taken_down_at" IS NOT NULL');
    const decodedCursor = decodeStudioCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("release"."taken_down_at", "release"."id") < (:cursorTakenDownAt, :cursorId)',
        {
          cursorTakenDownAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await queryBuilder
      .orderBy('release.takenDownAt', 'DESC')
      .addOrderBy('release.id', 'DESC')
      .limit(pageSize + 1)
      .getMany();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    if (!pageRows.length) {
      return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
    }
    const releaseIds = pageRows.map((release) => release.id);
    const [summaries, openDisputeIds] = await Promise.all([
      this.catalog.staffSummariesByReleaseId(releaseIds),
      this.openDisputeIdsByReleaseId(releaseIds),
    ]);
    const lastRelease = pageRows[pageRows.length - 1];
    return {
      items: pageRows.flatMap((release) => {
        const releaseSummary = summaries.get(release.id);
        return releaseSummary
          ? [
              {
                ...releaseSummary,
                openDisputeId: openDisputeIds.get(release.id) ?? null,
              },
            ]
          : [];
      }),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastRelease?.takenDownAt
            ? encodeStudioCursor({
                publishedAt: lastRelease.takenDownAt,
                id: lastRelease.id,
              })
            : null,
      },
    };
  }

  // One query for a whole page. `UQ_studio_release_disputes_open_release`
  // allows one open dispute per release, so each release maps to one id at
  // most; the frontend upholds it to restore the release.
  private async openDisputeIdsByReleaseId(
    releaseIds: string[],
  ): Promise<Map<string, string>> {
    const rows = await this.disputes
      .createQueryBuilder('dispute')
      .select('"dispute"."release_id"', 'release_id')
      .addSelect('"dispute"."id"', 'dispute_id')
      .where('"dispute"."release_id" IN (:...withdrawnReleaseIds)', {
        withdrawnReleaseIds: releaseIds,
      })
      .andWhere('"dispute"."status" = :openDisputeStatus', {
        openDisputeStatus: StudioReleaseDisputeStatus.Open,
      })
      .getRawMany<OpenDisputeRow>();
    return new Map(rows.map((row) => [row.release_id, row.dispute_id]));
  }
}
