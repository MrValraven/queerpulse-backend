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
import { encodeStudioCursor } from './studio-cursor';
import { StudioAdminReleaseSummary } from './studio-dispute-response';
import { StudioStaffReadsService } from './studio-staff-reads.service';

type WhereMock = jest.Mock<
  QueryBuilderMock,
  [predicate: string, parameters?: Record<string, unknown>]
>;

interface QueryBuilderMock {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: WhereMock;
  andWhere: WhereMock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  groupBy: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
}

function queryBuilderMock(
  result: { many?: unknown[]; raw?: unknown[] } = {},
): QueryBuilderMock {
  const queryBuilder = {} as QueryBuilderMock;
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'groupBy',
    'limit',
  ] as const) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(result.raw ?? []);
  return queryBuilder;
}

const releaseIdOf = (index: number): string =>
  `e3000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const disputeRow = (index: number): StudioReleaseDispute => ({
  id: `e4000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  releaseId: releaseIdOf(index),
  note: `Note ${index}`,
  status: StudioReleaseDisputeStatus.Open,
  staffReply: null,
  decidedById: null,
  createdAt: new Date(Date.UTC(2026, 9, 12, 9, 0, index)),
  decidedAt: null,
});

const takenDownRow = (index: number): StudioRelease =>
  ({
    id: releaseIdOf(index),
    takenDownAt: new Date(Date.UTC(2026, 9, 12, 8, 0, index)),
  }) as StudioRelease;

const summaryOf = (releaseId: string): StudioAdminReleaseSummary =>
  ({
    id: releaseId,
    title: `Release ${releaseId.slice(-2)}`,
    status: StudioReleaseStatus.TakenDown,
    takedownReason: 'Uploaded without the rights',
    takenDownAt: '2026-10-12T08:00:00.000Z',
  }) as StudioAdminReleaseSummary;

describe('StudioStaffReadsService', () => {
  let disputes: { createQueryBuilder: jest.Mock };
  let releases: { createQueryBuilder: jest.Mock };
  let catalog: { staffSummariesByReleaseId: jest.Mock };
  let service: StudioStaffReadsService;

  beforeEach(() => {
    disputes = { createQueryBuilder: jest.fn(() => queryBuilderMock()) };
    releases = { createQueryBuilder: jest.fn(() => queryBuilderMock()) };
    catalog = {
      staffSummariesByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(
            releaseIds.map((releaseId) => [releaseId, summaryOf(releaseId)]),
          ),
        ),
      ),
    };
    service = new StudioStaffReadsService(
      disputes as unknown as Repository<StudioReleaseDispute>,
      releases as unknown as Repository<StudioRelease>,
      catalog as unknown as StudioCatalogService,
    );
  });

  describe('listDisputes', () => {
    it('pages 20 at a time, newest first, and hands back a cursor at the 20th', async () => {
      const rows = Array.from({ length: 21 }, (_unused, index) =>
        disputeRow(21 - index),
      );
      const queryBuilder = queryBuilderMock({ many: rows });
      disputes.createQueryBuilder.mockReturnValue(queryBuilder);

      const page = await service.listDisputes(
        StudioReleaseDisputeStatus.Open,
        undefined,
      );

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'dispute.status = :disputeStatus',
        { disputeStatus: 'open' },
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        'dispute.createdAt',
        'DESC',
      );
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
        'dispute.id',
        'DESC',
      );
      expect(queryBuilder.limit).toHaveBeenCalledWith(21);
      expect(page.items).toHaveLength(20);
      expect(page.items[0]?.release).toEqual(summaryOf(rows[0]!.releaseId));
      expect(page.pageInfo).toEqual({
        hasMore: true,
        nextCursor: encodeStudioCursor({
          publishedAt: rows[19]!.createdAt,
          id: rows[19]!.id,
        }),
      });
    });

    it('seeks past a cursor and reads a malformed one as the first page', async () => {
      const seeking = queryBuilderMock();
      disputes.createQueryBuilder.mockReturnValueOnce(seeking);
      const cursorRow = disputeRow(5);
      await service.listDisputes(
        StudioReleaseDisputeStatus.Upheld,
        encodeStudioCursor({
          publishedAt: cursorRow.createdAt,
          id: cursorRow.id,
        }),
      );
      expect(seeking.andWhere).toHaveBeenCalledWith(
        '("dispute"."created_at", "dispute"."id") < (:cursorCreatedAt, :cursorId)',
        { cursorCreatedAt: cursorRow.createdAt, cursorId: cursorRow.id },
      );

      const firstPage = queryBuilderMock();
      disputes.createQueryBuilder.mockReturnValueOnce(firstPage);
      await service.listDisputes(
        StudioReleaseDisputeStatus.Open,
        'not-a-cursor',
      );
      expect(firstPage.andWhere).not.toHaveBeenCalled();
    });

    it('drops a dispute whose release has gone', async () => {
      disputes.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ many: [disputeRow(1), disputeRow(2)] }),
      );
      catalog.staffSummariesByReleaseId.mockResolvedValue(
        new Map([[releaseIdOf(2), summaryOf(releaseIdOf(2))]]),
      );

      const page = await service.listDisputes(
        StudioReleaseDisputeStatus.Open,
        undefined,
      );

      expect(page.items.map((item) => item.id)).toEqual([disputeRow(2).id]);
      expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    });
  });

  describe('listWithdrawn', () => {
    it('lists taken-down releases newest first with the id of their open dispute', async () => {
      const listing = queryBuilderMock({
        many: [takenDownRow(2), takenDownRow(1)],
      });
      releases.createQueryBuilder.mockReturnValue(listing);
      const openDispute = queryBuilderMock({
        raw: [{ release_id: releaseIdOf(1), dispute_id: disputeRow(1).id }],
      });
      disputes.createQueryBuilder.mockReturnValue(openDispute);

      const page = await service.listWithdrawn(undefined);

      expect(listing.where).toHaveBeenCalledWith(
        'release.status = :takenDownStatus',
        { takenDownStatus: 'taken_down' },
      );
      expect(listing.andWhere).toHaveBeenCalledWith(
        '"release"."taken_down_at" IS NOT NULL',
      );
      expect(listing.orderBy).toHaveBeenCalledWith(
        'release.takenDownAt',
        'DESC',
      );
      expect(listing.limit).toHaveBeenCalledWith(21);
      expect(openDispute.select).toHaveBeenCalledWith(
        '"dispute"."release_id"',
        'release_id',
      );
      expect(openDispute.addSelect).toHaveBeenCalledWith(
        '"dispute"."id"',
        'dispute_id',
      );
      expect(openDispute.where).toHaveBeenCalledWith(
        '"dispute"."release_id" IN (:...withdrawnReleaseIds)',
        { withdrawnReleaseIds: [releaseIdOf(2), releaseIdOf(1)] },
      );
      expect(openDispute.andWhere).toHaveBeenCalledWith(
        '"dispute"."status" = :openDisputeStatus',
        { openDisputeStatus: 'open' },
      );
      expect(page.items.map((item) => [item.id, item.openDisputeId])).toEqual([
        [releaseIdOf(2), null],
        [releaseIdOf(1), disputeRow(1).id],
      ]);
    });

    it('seeks past a cursor on the takedown time', async () => {
      const listing = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValue(listing);
      const cursorRow = takenDownRow(3);
      await service.listWithdrawn(
        encodeStudioCursor({
          publishedAt: cursorRow.takenDownAt!,
          id: cursorRow.id,
        }),
      );
      expect(listing.andWhere).toHaveBeenCalledWith(
        '("release"."taken_down_at", "release"."id") < (:cursorTakenDownAt, :cursorId)',
        { cursorTakenDownAt: cursorRow.takenDownAt, cursorId: cursorRow.id },
      );
    });

    it('counts nothing and asks nothing more for an empty page', async () => {
      releases.createQueryBuilder.mockReturnValue(queryBuilderMock());
      const page = await service.listWithdrawn(undefined);
      expect(page).toEqual({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
      expect(disputes.createQueryBuilder).not.toHaveBeenCalled();
      expect(catalog.staffSummariesByReleaseId).not.toHaveBeenCalled();
    });
  });
});
