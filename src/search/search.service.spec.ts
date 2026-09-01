import { SearchService } from './search.service';
import { SearchResultType } from './dto/search.query';
import { isResultTypeLaunched } from './search-features';

// Direct construction (mirrors `mention-notification.service.spec.ts`): the 12
// federated resources are injected verbatim, so each is a minimal fake exposing
// only the one method `SearchService` calls on it. The real `*ToResult` mappers
// run against the rows these fakes return.
function build() {
  const profiles = {
    searchMembers: jest.fn().mockResolvedValue({ items: [] }),
  };
  const directory = { listDirectory: jest.fn().mockResolvedValue([]) };
  const communities = { searchByText: jest.fn().mockResolvedValue([]) };
  const events = { searchByText: jest.fn().mockResolvedValue([]) };
  const forumThreads = { searchByText: jest.fn().mockResolvedValue([]) };
  const forumPosts = { searchByText: jest.fn().mockResolvedValue([]) };
  const magazine = { searchByText: jest.fn().mockResolvedValue([]) };
  const jobs = { searchByText: jest.fn().mockResolvedValue([]) };
  const housing = { searchByText: jest.fn().mockResolvedValue([]) };
  const resources = { searchByText: jest.fn().mockResolvedValue([]) };
  const subprofiles = { searchByText: jest.fn().mockResolvedValue([]) };
  const topics = { searchByText: jest.fn().mockResolvedValue([]) };

  const service = new SearchService(
    profiles as never,
    directory as never,
    communities as never,
    events as never,
    forumThreads as never,
    forumPosts as never,
    magazine as never,
    jobs as never,
    housing as never,
    resources as never,
    subprofiles as never,
    topics as never,
  );

  return {
    service,
    profiles,
    directory,
    communities,
    events,
    forumThreads,
    forumPosts,
    magazine,
    jobs,
    housing,
    resources,
    subprofiles,
    topics,
  };
}

const memberCard = (slug: string) => ({
  slug,
  firstName: 'Ada',
  lastName: 'Lovelace',
  tagline: 'engineer',
  location: 'Lisbon',
  avatarUrl: null,
});

const communityCard = (slug: string) => ({
  slug,
  name: `Community ${slug}`,
  type: 'group',
  memberCount: 12,
});

const postRow = (threadSlug: string) => ({
  threadSlug,
  threadTitle: 'Trans-friendly GP in Lisbon?',
  threadCategory: 'health',
  excerpt: 'Dr. Sousa at the health centre was wonderful with me.',
});

describe('SearchService.search', () => {
  it('short-circuits an empty/whitespace query without touching any resource', async () => {
    const bag = build();

    const result = await bag.service.search(
      'viewer-1',
      '   ',
      undefined,
      undefined,
    );

    expect(result).toEqual({ query: '', results: [], hasMore: false });
    expect(bag.profiles.searchMembers).not.toHaveBeenCalled();
    expect(bag.communities.searchByText).not.toHaveBeenCalled();
    expect(bag.directory.listDirectory).not.toHaveBeenCalled();
  });

  it('with no type filter queries every resource, threading the viewer id', async () => {
    const bag = build();

    await bag.service.search('viewer-1', 'pride', undefined, undefined);

    expect(bag.profiles.searchMembers).toHaveBeenCalledWith(
      { query: 'pride' },
      'viewer-1',
      { offset: 0, limit: 6 },
    );
    expect(bag.communities.searchByText).toHaveBeenCalledWith(
      'viewer-1',
      'pride',
      6,
    );
    // Text-only resources (no viewer scoping) still get the query + per-type cap.
    expect(bag.magazine.searchByText).toHaveBeenCalledWith('pride', 6);
    expect(bag.directory.listDirectory).toHaveBeenCalledWith({ q: 'pride' });
    expect(bag.subprofiles.searchByText).toHaveBeenCalled();
  });

  it('queries reply bodies as their own type, threading the viewer id (SOC-08)', async () => {
    const bag = build();

    await bag.service.search('viewer-1', 'pride', undefined, undefined);

    expect(bag.forumPosts.searchByText).toHaveBeenCalledWith(
      'viewer-1',
      'pride',
      6,
      0,
    );
  });

  it('a type filter narrows to exactly that one resource', async () => {
    const bag = build();

    await bag.service.search(
      'viewer-1',
      'pride',
      SearchResultType.Community,
      undefined,
    );

    expect(bag.communities.searchByText).toHaveBeenCalledTimes(1);
    expect(bag.profiles.searchMembers).not.toHaveBeenCalled();
    expect(bag.events.searchByText).not.toHaveBeenCalled();
    expect(bag.magazine.searchByText).not.toHaveBeenCalled();
    expect(bag.forumPosts.searchByText).not.toHaveBeenCalled();
  });

  it('maps a reply hit onto its thread slug, with the excerpt as the subline', async () => {
    const bag = build();
    bag.forumPosts.searchByText.mockResolvedValue([postRow('gp-lisbon')]);

    const result = await bag.service.search(
      'viewer-1',
      'gp',
      SearchResultType.ForumPost,
      undefined,
    );

    expect(result.results).toEqual([
      {
        type: 'forumPost',
        slug: 'gp-lisbon',
        name: 'Trans-friendly GP in Lisbon?',
        sub: 'Dr. Sousa at the health centre was wonderful with me.',
      },
    ]);
  });

  it('caps each resource at PER_TYPE_LIMIT and orders members before communities', async () => {
    const bag = build();
    bag.profiles.searchMembers.mockResolvedValue({
      items: Array.from({ length: 6 }, (_, index) => memberCard(`m${index}`)),
    });
    bag.communities.searchByText.mockResolvedValue([
      communityCard('c0'),
      communityCard('c1'),
    ]);

    const result = await bag.service.search(
      'viewer-1',
      'pride',
      undefined,
      undefined,
    );

    expect(result.results).toHaveLength(8);
    const types = result.results.map((row) => row.type);
    // TYPE_ORDER places every member hit ahead of every community hit.
    expect(types.slice(0, 6)).toEqual(Array(6).fill('member'));
    expect(types.slice(6)).toEqual(['community', 'community']);
    expect(result.query).toBe('pride');
  });

  it('honours the caller-supplied total limit across the flattened list', async () => {
    const bag = build();
    bag.profiles.searchMembers.mockResolvedValue({
      items: Array.from({ length: 6 }, (_, index) => memberCard(`m${index}`)),
    });
    bag.communities.searchByText.mockResolvedValue([communityCard('c0')]);

    const result = await bag.service.search('viewer-1', 'pride', undefined, 3);

    expect(result.results).toHaveLength(3);
    expect(result.results.every((row) => row.type === 'member')).toBe(true);
  });

  describe('pagination past the per-type cap (SOC-08)', () => {
    it('asks for one probe row beyond the page and reports hasMore without returning it', async () => {
      const bag = build();
      bag.communities.searchByText.mockResolvedValue(
        Array.from({ length: 11 }, (_, index) => communityCard(`c${index}`)),
      );

      const result = await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.Community,
        10,
      );

      expect(bag.communities.searchByText).toHaveBeenCalledWith(
        'viewer-1',
        'pride',
        11,
      );
      expect(result.results).toHaveLength(10);
      expect(result.hasMore).toBe(true);
    });

    it('reports hasMore false when the probe row does not come back', async () => {
      const bag = build();
      bag.communities.searchByText.mockResolvedValue(
        Array.from({ length: 4 }, (_, index) => communityCard(`c${index}`)),
      );

      const result = await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.Community,
        10,
      );

      expect(result.results).toHaveLength(4);
      expect(result.hasMore).toBe(false);
    });

    it('passes a real offset to the three types whose query takes one', async () => {
      const bag = build();

      await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.Forum,
        10,
        20,
      );
      expect(bag.forumThreads.searchByText).toHaveBeenCalledWith(
        'viewer-1',
        'pride',
        11,
        20,
      );

      await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.ForumPost,
        10,
        20,
      );
      expect(bag.forumPosts.searchByText).toHaveBeenCalledWith(
        'viewer-1',
        'pride',
        11,
        20,
      );

      await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.Member,
        10,
        20,
      );
      expect(bag.profiles.searchMembers).toHaveBeenCalledWith(
        { query: 'pride' },
        'viewer-1',
        { offset: 20, limit: 11 },
      );
    });

    it('emulates the offset for a type whose query takes only a limit', async () => {
      const bag = build();
      bag.magazine.searchByText.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => ({
          slug: `a${index}`,
          title: `Article ${index}`,
          dek: 'dek',
        })),
      );

      const result = await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.Magazine,
        10,
        20,
      );

      // offset (20) + page (10) + one probe row.
      expect(bag.magazine.searchByText).toHaveBeenCalledWith('pride', 31);
      // Only rows 20..24 survived the skip, so there is no further page.
      expect(result.results).toHaveLength(5);
      expect(result.hasMore).toBe(false);
      expect(result.results[0]?.name).toBe('Article 20');
    });

    it('ignores an offset on the unfiltered, all-types view', async () => {
      const bag = build();

      await bag.service.search('viewer-1', 'pride', undefined, undefined, 40);

      expect(bag.magazine.searchByText).toHaveBeenCalledWith('pride', 6);
      expect(bag.forumThreads.searchByText).toHaveBeenCalledWith(
        'viewer-1',
        'pride',
        6,
        0,
      );
    });

    it('clamps an offset beyond the ceiling', async () => {
      const bag = build();

      await bag.service.search(
        'viewer-1',
        'pride',
        SearchResultType.Forum,
        10,
        9999,
      );

      expect(bag.forumThreads.searchByText).toHaveBeenCalledWith(
        'viewer-1',
        'pride',
        11,
        200,
      );
    });
  });

  describe('feature launch gating', () => {
    type Bag = ReturnType<typeof build>;

    // The one fake `SearchService` reaches for to produce each result type.
    // Forum titles and reply bodies are separate queries under a single
    // feature, so both appear here.
    const queryFor: Record<SearchResultType, (bag: Bag) => jest.Mock> = {
      [SearchResultType.Member]: (bag) => bag.profiles.searchMembers,
      [SearchResultType.Community]: (bag) => bag.communities.searchByText,
      [SearchResultType.Event]: (bag) => bag.events.searchByText,
      [SearchResultType.Forum]: (bag) => bag.forumThreads.searchByText,
      [SearchResultType.ForumPost]: (bag) => bag.forumPosts.searchByText,
      [SearchResultType.Business]: (bag) => bag.directory.listDirectory,
      [SearchResultType.Magazine]: (bag) => bag.magazine.searchByText,
      [SearchResultType.Job]: (bag) => bag.jobs.searchByText,
      [SearchResultType.Housing]: (bag) => bag.housing.searchByText,
      [SearchResultType.Resource]: (bag) => bag.resources.searchByText,
      [SearchResultType.Subprofile]: (bag) => bag.subprofiles.searchByText,
      [SearchResultType.Topic]: (bag) => bag.topics.searchByText,
    };

    const allResultTypes = Object.values(SearchResultType);

    it('queries a resource on the unfiltered view only while its feature is launched', async () => {
      const bag = build();

      await bag.service.search('viewer-1', 'pride', undefined, undefined);

      // Asserted in both directions for all twelve types, so this stays a real
      // assertion whichever way a flag is flipped in `launchedFeatures.ts`.
      for (const resultType of allResultTypes) {
        const wasQueried = queryFor[resultType](bag).mock.calls.length > 0;
        expect({ resultType, wasQueried }).toEqual({
          resultType,
          wasQueried: isResultTypeLaunched(resultType),
        });
      }
    });

    // Registry-driven rather than naming `job` outright: today the closed set
    // is the Work and Economy surface, tomorrow it is whatever
    // `launchedFeatures.ts` says. If every searched feature is ever launched
    // at once this loop has nothing to iterate; `search-features.spec.ts`
    // proves the gate itself against a fabricated registry, so the mechanism
    // stays covered either way.
    const closedResultTypes = allResultTypes.filter(
      (resultType) => !isResultTypeLaunched(resultType),
    );

    it('returns an empty page for a closed feature even when its resource has rows', async () => {
      for (const resultType of closedResultTypes) {
        const bag = build();
        // Rows the fake would happily hand back if it were ever asked.
        queryFor[resultType](bag).mockResolvedValue([
          {
            slug: 'backend-engineer',
            title: 'Backend Engineer',
            category: 'Engineering',
            location: 'Remote',
          },
        ]);

        const result = await bag.service.search(
          'viewer-1',
          'pride',
          resultType,
          undefined,
        );

        expect(result).toEqual({ query: 'pride', results: [], hasMore: false });
        expect(queryFor[resultType](bag)).not.toHaveBeenCalled();
      }
    });

    it('leaves a closed feature out of the merged, all-types list', async () => {
      const bag = build();
      for (const resultType of closedResultTypes) {
        queryFor[resultType](bag).mockResolvedValue([
          { slug: 'backend-engineer', title: 'Backend Engineer' },
        ]);
      }

      const result = await bag.service.search(
        'viewer-1',
        'pride',
        undefined,
        undefined,
      );

      // `SearchResultDTO.type` is the widened `` `${SearchResultType}` ``
      // string, so compare on the string value the enum member carries.
      const returnedTypes = result.results.map((row) => String(row.type));
      for (const resultType of closedResultTypes) {
        expect(returnedTypes).not.toContain(String(resultType));
      }
    });

    // `launchedTypes()` is what the frontend builds its category tabs from, so
    // it has to describe THIS service, not a parallel opinion about it. The
    // assertion runs against the real registry and compares the advertised
    // list to the queries `search` actually issued, in both directions: a type
    // advertised but never queried would give a member a tab that can only
    // ever be empty, and a type queried but not advertised would hide results
    // that do exist.
    it('advertises exactly the types the unfiltered search queries', async () => {
      const bag = build();

      await bag.service.search('viewer-1', 'pride', undefined, undefined);
      const advertised = new Set(bag.service.launchedTypes().types);

      for (const resultType of allResultTypes) {
        const wasQueried = queryFor[resultType](bag).mock.calls.length > 0;
        expect({
          resultType,
          isAdvertised: advertised.has(resultType),
        }).toEqual({ resultType, isAdvertised: wasQueried });
      }
    });

    it('advertises no type that returns an empty page when asked for by name', async () => {
      for (const resultType of allResultTypes) {
        const bag = build();
        const advertised = new Set(bag.service.launchedTypes().types);
        // One row the resource would hand back if it were ever asked.
        // `ProfilesService.searchMembers` alone answers with a page envelope
        // rather than a bare array, so it gets its own shape.
        queryFor[resultType](bag).mockResolvedValue(
          resultType === SearchResultType.Member
            ? { items: [memberCard('ada')] }
            : [
                {
                  slug: 'backend-engineer',
                  threadSlug: 'backend-engineer',
                  handle: 'backend-engineer',
                  tag: 'hiring',
                  title: 'Backend Engineer',
                  threadTitle: 'Backend Engineer',
                  name: 'Backend Engineer',
                  category: 'Engineering',
                  location: 'Remote',
                },
              ],
        );

        const result = await bag.service.search(
          'viewer-1',
          'pride',
          resultType,
          undefined,
        );

        expect({
          resultType,
          isAdvertised: advertised.has(resultType),
        }).toEqual({ resultType, isAdvertised: result.results.length > 0 });
      }
    });
  });
});
