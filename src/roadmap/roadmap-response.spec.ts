import { RoadmapColumn, RoadmapItem } from './entities/roadmap-item.entity';
import { computeHeroStats, lisbonYear } from './roadmap-response';

const item = (column: RoadmapColumn, date: string | null = null) =>
  ({ column, date }) as RoadmapItem;

describe('computeHeroStats', () => {
  it('counts shipped items of the given year, building and planned items', () => {
    const stats = computeHeroStats(
      [
        item(RoadmapColumn.Shipped, 'May 2026'),
        item(RoadmapColumn.Shipped, 'Dec 2025'),
        item(RoadmapColumn.Shipped, null),
        item(RoadmapColumn.Building),
        item(RoadmapColumn.Building),
        item(RoadmapColumn.Planned),
        item(RoadmapColumn.Backlog),
      ],
      2026,
    );
    expect(stats).toEqual([
      { kind: 'shipped', count: 1 },
      { kind: 'building', count: 2 },
      { kind: 'planned', count: 1 },
    ]);
  });

  it('returns zero counts for an empty board', () => {
    expect(computeHeroStats([], 2026).map((stat) => stat.count)).toEqual([
      0, 0, 0,
    ]);
  });
});

describe('lisbonYear', () => {
  it('rolls over at midnight Lisbon time', () => {
    expect(lisbonYear(new Date('2026-12-31T23:30:00Z'))).toBe(2026);
    expect(lisbonYear(new Date('2026-06-30T23:30:00Z'))).toBe(2026);
    expect(lisbonYear(new Date('2027-01-01T00:30:00Z'))).toBe(2027);
  });
});
