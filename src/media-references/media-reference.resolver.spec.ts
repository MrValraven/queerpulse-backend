import type { DataSource } from 'typeorm';
import { MediaReferenceResolver } from './media-reference.resolver';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { Profile } from '../users/entities/profile.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Company } from '../companies/entities/company.entity';

/** A repository stub covering both call shapes `MediaReferenceSource`s use:
 *  plain-column sources call `repository.find(...)`; structured/array
 *  sources call `repository.createQueryBuilder(alias).where(...).getMany()`.
 *  Tests supply canned rows unconditionally (ignoring the query args) — the
 *  resolver itself re-filters every match against the caller's candidate
 *  bare keys, so an over-broad stub row is still asserted correctly. */
function makeMockRepository(
  config: {
    findRows?: unknown[];
    queryBuilderRows?: unknown[];
    findImplementation?: () => Promise<unknown[]>;
  } = {},
) {
  const findMock = config.findImplementation
    ? jest.fn(config.findImplementation)
    : jest.fn().mockResolvedValue(config.findRows ?? []);
  const queryBuilderStub = {
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(config.queryBuilderRows ?? []),
  };
  return {
    find: findMock,
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilderStub),
    metadata: { tableName: 'mock_table' },
  };
}

/** Builds a `DataSource` stub whose `getRepository` returns the entity's
 *  overridden mock repository, or a default empty repository otherwise —
 *  so every one of the 18 registered sources resolves cleanly even when a
 *  test only cares about one or two of them. Takes an entries array (not a
 *  `Map` literal) so TypeScript doesn't try to unify the mock repository
 *  shapes of unrelated entities into one tuple type. */
function createMockDataSource(
  repositoryOverrides: Array<[unknown, ReturnType<typeof makeMockRepository>]>,
): DataSource {
  const repositoriesByEntity = new Map<
    unknown,
    ReturnType<typeof makeMockRepository>
  >(repositoryOverrides);
  return {
    getRepository: jest.fn((entity: unknown) => {
      return repositoriesByEntity.get(entity) ?? makeMockRepository();
    }),
  } as unknown as DataSource;
}

describe('MediaReferenceResolver', () => {
  it('normalizes a /files/<key> URL and resolves a story-cover reference', async () => {
    const bareKey = 'story-covers/one.jpg';
    const storedValue = `/files/${bareKey}`;
    const dataSource = createMockDataSource([
      [
        MagazineIssue,
        makeMockRepository({
          findRows: [
            { id: 'issue-1', coverUrl: storedValue, title: 'Issue One' },
          ],
        }),
      ],
    ]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references, degraded } = await resolver.resolve([bareKey]);

    expect(references.get(bareKey)).toEqual([
      { type: 'story-cover', entityId: 'issue-1', label: 'Issue One' },
    ]);
    // Every source resolved cleanly, so the set is authoritative.
    expect(degraded).toBe(false);
  });

  it('returns two references when a key is used by two sources', async () => {
    const bareKey = 'avatars/user-1/live.jpg';
    const dataSource = createMockDataSource([
      [
        Profile,
        makeMockRepository({
          findRows: [
            {
              userId: 'user-1',
              avatarUrl: bareKey,
              firstName: 'Ada',
              lastName: 'Lovelace',
              slug: 'ada',
            },
          ],
        }),
      ],
      [
        WorkItem,
        makeMockRepository({
          findRows: [
            { id: 'work-1', imageUrl: bareKey, title: 'Showcase Piece' },
          ],
        }),
      ],
    ]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references } = await resolver.resolve([bareKey]);

    expect(references.get(bareKey)).toEqual(
      expect.arrayContaining([
        {
          type: 'profile-photo',
          entityId: 'user-1',
          label: 'Ada Lovelace',
          slug: 'ada',
        },
        { type: 'showcase', entityId: 'work-1', label: 'Showcase Piece' },
      ]),
    );
    expect(references.get(bareKey)).toHaveLength(2);
  });

  it('leaves an unreferenced key absent from the map', async () => {
    const dataSource = createMockDataSource([]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references } = await resolver.resolve(['uploads/nobody/orphan.jpg']);

    expect(references.has('uploads/nobody/orphan.jpg')).toBe(false);
  });

  it('swallows a throwing source and still resolves the others', async () => {
    const bareKey = 'avatars/user-1/live.jpg';
    const dataSource = createMockDataSource([
      [
        Profile,
        makeMockRepository({
          findImplementation: () => Promise.reject(new Error('db is down')),
        }),
      ],
      [
        WorkItem,
        makeMockRepository({
          findRows: [
            { id: 'work-1', imageUrl: bareKey, title: 'Showcase Piece' },
          ],
        }),
      ],
    ]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references, degraded } = await resolver.resolve([bareKey]);

    expect(references.get(bareKey)).toEqual([
      { type: 'showcase', entityId: 'work-1', label: 'Showcase Piece' },
    ]);
    // A swallowed source error must flag the whole resolution as degraded so
    // callers never present the incomplete set as "safe to delete".
    expect(degraded).toBe(true);
  });

  it('resolves a listing reference from the photos jsonb map', async () => {
    const bareKey = 'listing-photos/owner-1/wide.jpg';
    const dataSource = createMockDataSource([
      [
        Listing,
        makeMockRepository({
          queryBuilderRows: [
            {
              id: 'listing-1',
              name: 'Great Listing',
              slug: 'great-listing',
              photos: { wide: bareKey, d1: '', d2: '', vibe: '' },
            },
          ],
        }),
      ],
    ]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references } = await resolver.resolve([bareKey]);

    expect(references.get(bareKey)).toEqual([
      {
        type: 'listing',
        entityId: 'listing-1',
        label: 'Great Listing',
        slug: 'great-listing',
      },
    ]);
  });

  it('resolves a company-work reference from work[].imageUrl', async () => {
    const bareKey = 'company-work/owner-1/two.jpg';
    const dataSource = createMockDataSource([
      [
        Company,
        makeMockRepository({
          queryBuilderRows: [
            {
              id: 'company-1',
              nameText: 'Acme Co',
              slug: 'acme-co',
              work: [
                { imageUrl: 'company-work/owner-1/one.jpg' },
                { imageUrl: bareKey },
              ],
            },
          ],
        }),
      ],
    ]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references } = await resolver.resolve([bareKey]);

    expect(references.get(bareKey)).toEqual([
      {
        type: 'company-work',
        entityId: 'company-1',
        label: 'Acme Co',
        slug: 'acme-co',
      },
    ]);
  });

  it('rejects a LIKE-prefiltered row whose exact ref is not a candidate (no false positives)', async () => {
    const bareKey = 'listing-photos/owner-1/wide.jpg';
    const dataSource = createMockDataSource([
      [
        Listing,
        makeMockRepository({
          // This row's `wide` value merely CONTAINS bareKey as a substring
          // (would pass a `LIKE '%bareKey%'` prefilter) but is not an exact
          // stored form of it — it must be rejected, not matched.
          queryBuilderRows: [
            {
              id: 'listing-2',
              name: 'Decoy Listing',
              slug: 'decoy-listing',
              photos: { wide: `${bareKey}.bak`, d1: '', d2: '', vibe: '' },
            },
          ],
        }),
      ],
    ]);
    const resolver = new MediaReferenceResolver(dataSource);

    const { references } = await resolver.resolve([bareKey]);

    expect(references.has(bareKey)).toBe(false);
  });
});
