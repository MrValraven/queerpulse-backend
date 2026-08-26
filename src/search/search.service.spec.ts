import { SearchService } from './search.service';
import { SearchResultType } from './dto/search.query';

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
});
