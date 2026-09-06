import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { SavedAvailabilityService } from './saved-availability.service';

/**
 * One chainable query-builder stub per resolved kind. `getRawMany` resolves to
 * whatever `rowsByAlias` holds for the alias the service asked for, which is
 * how a test says "this slug is still there and that one is not".
 */
const makeManager = (rowsByAlias: Record<string, string[]> = {}) => {
  const createQueryBuilder = jest.fn((_entity: unknown, alias: string) => {
    const queryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['where', 'andWhere', 'select']) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getRawMany = jest
      .fn()
      .mockResolvedValue(
        (rowsByAlias[alias] ?? []).map((key) => ({ subject_key: key })),
      );
    return queryBuilder;
  });
  return {
    createQueryBuilder,
    connection: {
      // Every probed column is reported present: the `deleted_at` probe exists
      // for a sibling module mid-flight, not as behaviour this file owns.
      getMetadata: jest.fn(() => ({
        columns: [{ propertyName: 'deletedAt' }],
      })),
    },
  };
};

const ref = (
  subjectType: SavedKind,
  subjectId: string,
): Pick<SavedItem, 'subjectType' | 'subjectId'> => ({ subjectType, subjectId });

describe('SavedAvailabilityService', () => {
  let manager: ReturnType<typeof makeManager>;
  let service: SavedAvailabilityService;

  const build = async (rowsByAlias: Record<string, string[]> = {}) => {
    manager = makeManager(rowsByAlias);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedAvailabilityService,
        {
          provide: getRepositoryToken(SavedItem),
          useValue: { manager },
        },
        {
          provide: BlockFilterService,
          useValue: {
            excludeBlocked: jest.fn((queryBuilder: unknown) => queryBuilder),
          },
        },
      ],
    }).compile();
    service = module.get(SavedAvailabilityService);
  };

  it('asks nothing at all for an empty page', async () => {
    await build();
    const available = await service.availableRefs([], 'viewer-1');
    expect(available.size).toBe(0);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('resolves a whole page of ONE kind in a single query, never one per item', async () => {
    await build({ thread: ['first', 'second', 'third'] });

    const available = await service.availableRefs(
      [
        ref(SavedKind.Post, 'first'),
        ref(SavedKind.Post, 'second'),
        ref(SavedKind.Post, 'third'),
      ],
      'viewer-1',
    );

    // The N+1 this service exists to prevent. Three saved threads, one query.
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(available).toEqual(
      new Set(['post:first', 'post:second', 'post:third']),
    );
  });

  it('costs one query PER KIND on the page, not one per item', async () => {
    await build({ thread: ['a-thread'], community: ['a-group'] });

    await service.availableRefs(
      [
        ref(SavedKind.Post, 'a-thread'),
        ref(SavedKind.Post, 'another-thread'),
        ref(SavedKind.Group, 'a-group'),
        ref(SavedKind.Group, 'another-group'),
      ],
      'viewer-1',
    );

    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it('reports a subject the query did not return as NOT available', async () => {
    // The thread was deleted, or its community went private: it is simply
    // absent from the result rather than flagged.
    await build({ thread: ['still-here'] });

    const available = await service.availableRefs(
      [ref(SavedKind.Post, 'still-here'), ref(SavedKind.Post, 'long-gone')],
      'viewer-1',
    );

    expect(available.has('post:still-here')).toBe(true);
    expect(available.has('post:long-gone')).toBe(false);
  });

  it('deduplicates a subject id repeated on the page', async () => {
    await build({ listing: ['drama-bar'] });

    const available = await service.availableRefs(
      [
        ref(SavedKind.Listing, 'drama-bar'),
        ref(SavedKind.Listing, 'drama-bar'),
      ],
      'viewer-1',
    );

    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(available).toEqual(new Set(['listing:drama-bar']));
  });

  describe('an anonymous share-link recipient', () => {
    it('can still open the business directory', async () => {
      await build({ listing: ['drama-bar'] });

      const available = await service.availableRefs(
        [ref(SavedKind.Listing, 'drama-bar')],
        null,
      );

      expect(available).toEqual(new Set(['listing:drama-bar']));
    });

    it('gets "unavailable" for every member-only kind, without querying', async () => {
      await build({ thread: ['a-thread'], community: ['a-group'] });

      const available = await service.availableRefs(
        [
          ref(SavedKind.Post, 'a-thread'),
          ref(SavedKind.Group, 'a-group'),
          ref(SavedKind.Housing, 'a-room'),
          ref(SavedKind.Article, 'a-piece'),
        ],
        null,
      );

      // Every one of those modules puts `ActiveMemberGuard` on its controller,
      // so the card would land the recipient on a sign-in wall. Refused before
      // any SQL runs.
      expect(available.size).toBe(0);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  it('refuses a kind whose feature is not launched, without querying', async () => {
    await build({ job: ['senior-eng'], title: ['a-film-uuid'] });

    const available = await service.availableRefs(
      [
        ref(SavedKind.Job, 'senior-eng'),
        ref(SavedKind.Film, '00000000-0000-4000-8000-000000000000'),
      ],
      'viewer-1',
    );

    // `jobs` and `cinema` are both `launched: false`, so every route that
    // would render these is 404ed by `LaunchedFeaturesGuard`. No page to
    // navigate to means no availability to claim.
    expect(available.size).toBe(0);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });
});
