import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ResourceGuideRating } from './entities/resource-guide-rating.entity';
import { AdminResourceGuideRatingsService } from './admin-resource-guide-ratings.service';

// A chainable query-builder stub whose terminal method resolves to the given
// raw rows — mirrors `roadmap.service.ts`'s `liveVoteCounts` groupBy shape.
function qbStub(
  rows: { contentKey: string; helpfulCount: string; notHelpfulCount: string }[],
) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'addSelect', 'groupBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

describe('AdminResourceGuideRatingsService', () => {
  it('sorts worst-ratio-first', async () => {
    const ratings = {
      createQueryBuilder: jest.fn().mockReturnValue(
        qbStub([
          { contentKey: 'good.guide', helpfulCount: '9', notHelpfulCount: '1' },
          { contentKey: 'bad.guide', helpfulCount: '1', notHelpfulCount: '9' },
          { contentKey: 'mid.guide', helpfulCount: '5', notHelpfulCount: '5' },
        ]),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminResourceGuideRatingsService,
        { provide: getRepositoryToken(ResourceGuideRating), useValue: ratings },
      ],
    }).compile();
    const service = module.get(AdminResourceGuideRatingsService);

    const result = await service.list();

    expect(result.map((row) => row.contentKey)).toEqual([
      'bad.guide',
      'mid.guide',
      'good.guide',
    ]);
    expect(result[0]).toEqual({
      contentKey: 'bad.guide',
      helpfulCount: 1,
      notHelpfulCount: 9,
      ratio: 0.1,
    });
  });
});
