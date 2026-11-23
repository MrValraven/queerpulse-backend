import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { AuditFeedViewer, ModAuditService } from './mod-audit.service';

/**
 * SEC-31: the governance audit feed (and its CSV) leaves out, for the staff
 * member reading it, every row tied to a report about them. SQL takes the
 * rows it can decide (a sanction targeting them, a `member` report against
 * them); the viewer's rule takes the rest, page by page.
 */

const VIEWER_ID = '11111111-1111-4111-8111-111111111111';

interface QueryBuilderStub {
  orderBy: jest.Mock;
  andWhere: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  select: jest.Mock;
  distinct: jest.Mock;
  where: jest.Mock;
  getCount: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
}

function auditRow(id: string, reportId: string | null): ModAuditLog {
  return Object.assign(new ModAuditLog(), {
    id,
    reportId,
    actorId: null,
    action: 'dismiss',
    reasonCode: null,
    note: null,
    duration: null,
    targetUserId: null,
    targetName: null,
    createdAt: new Date('2026-11-22T10:00:00.000Z'),
  });
}

function queryBuilderStub(rows: ModAuditLog[]): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {
    orderBy: jest.fn(),
    andWhere: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    select: jest.fn(),
    distinct: jest.fn(),
    where: jest.fn(),
    getCount: jest.fn().mockResolvedValue(rows.length),
    getMany: jest.fn().mockResolvedValue(rows),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  for (const chained of [
    queryBuilder.orderBy,
    queryBuilder.andWhere,
    queryBuilder.skip,
    queryBuilder.take,
    queryBuilder.select,
    queryBuilder.distinct,
    queryBuilder.where,
  ]) {
    chained.mockReturnValue(queryBuilder);
  }
  return queryBuilder;
}

describe('ModAuditService: the audit feed for a reported staff member (SEC-31)', () => {
  let service: ModAuditService;
  let feedQueryBuilder: QueryBuilderStub;
  let auditLogs: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    feedQueryBuilder = queryBuilderStub([
      auditRow('row-about-viewer', 'report-about-viewer'),
      auditRow('row-about-other', 'report-about-other'),
      auditRow('row-platform', null),
    ]);
    auditLogs = { createQueryBuilder: jest.fn(() => feedQueryBuilder) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModAuditService,
        { provide: getRepositoryToken(ModAuditLog), useValue: auditLogs },
        {
          provide: getRepositoryToken(Report),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(User), useValue: {} },
      ],
    }).compile();
    service = module.get(ModAuditService);
  });

  function viewer(): AuditFeedViewer {
    return {
      userId: VIEWER_ID,
      reportIdsAboutViewer: jest.fn((reportIds: string[]) =>
        Promise.resolve(
          new Set(
            reportIds.filter((reportId) => reportId === 'report-about-viewer'),
          ),
        ),
      ),
    };
  }

  it('drops the rows tied to a report about the viewer and lowers the count', async () => {
    const feed = await service.auditFeed({}, viewer());

    expect(feed.items).toHaveLength(2);
    expect(feed.total).toBe(2);
    // The SQL half: a sanction targeting the viewer, and a member report
    // against them, are excluded with the viewer bound.
    expect(feedQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('log.targetUserId'),
      { viewerUserId: VIEWER_ID },
    );
    // A citation against the viewer is left out the same way.
    expect(feedQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("log.action <> 'evidence_cited'"),
      { viewerUserId: VIEWER_ID },
    );
  });

  it('drops the same rows from the CSV export', async () => {
    const csv = await service.auditFeedCsv({}, viewer());

    // A header and the two rows left.
    expect(csv.split('\n')).toHaveLength(3);
  });

  it('reads the full feed when no viewer is given', async () => {
    const feed = await service.auditFeed({});

    expect(feed.items).toHaveLength(3);
    expect(feedQueryBuilder.andWhere).not.toHaveBeenCalled();
  });
});
