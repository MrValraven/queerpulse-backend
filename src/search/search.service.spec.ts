import { SearchService } from './search.service';
import { SearchResultType } from './dto/search.query';

// Direct construction (mirrors `mention-notification.service.spec.ts`): the 11
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
  const magazine = { searchByText: jest.fn().mockResolvedValue([]) };
  const jobs = { searchByText: jest.fn().mockResolvedValue([]) };
  const housing = { searchByText: jest.fn().mockResolvedValue([]) };
  const resources = { searchByText: jest.fn().mockResolvedValue([]) };
  const workshops = { searchByText: jest.fn().mockResolvedValue([]) };
  const subprofiles = { searchByText: jest.fn().mockResolvedValue([]) };

  const service = new SearchService(
    profiles as never,
    directory as never,
    communities as never,
    events as never,
    forumThreads as never,
    magazine as never,
    jobs as never,
    housing as never,
    resources as never,
    workshops as never,
    subprofiles as never,
  );

  return {
    service,
    profiles,
    directory,
    communities,
    events,
    forumThreads,
    magazine,
    jobs,
    housing,
    resources,
    workshops,
    subprofiles,
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

describe('SearchService.search', () => {
  it('short-circuits an empty/whitespace query without touching any resource', async () => {
    const bag = build();

    const result = await bag.service.search(
      'viewer-1',
      '   ',
      undefined,
      undefined,
    );

    expect(result).toEqual({ query: '', results: [] });
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
  });

  it('caps each resource at PER_TYPE_LIMIT and orders members before communities', async () => {
    const bag = build();
    // Seven member cards -> sliced to 6; two communities appended after.
    bag.profiles.searchMembers.mockResolvedValue({
      items: Array.from({ length: 7 }, (_, index) => memberCard(`m${index}`)),
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
});
