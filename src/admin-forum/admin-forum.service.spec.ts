import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { AdminForumService } from './admin-forum.service';

describe('AdminForumService', () => {
  let service: AdminForumService;
  let threads: jest.Mocked<
    Pick<
      ForumThreadsService,
      'setOfficial' | 'listPendingReview' | 'reviewThread'
    >
  >;

  const admin: CurrentUserData = {
    userId: 'admin-1',
    email: 'admin@example.com',
    status: 'active',
    role: 'admin',
  };

  const moderator: CurrentUserData = {
    userId: 'mod-1',
    email: 'mod@example.com',
    status: 'active',
    role: 'moderator',
  };

  beforeEach(() => {
    threads = {
      setOfficial: jest.fn().mockResolvedValue({ slug: 'hello-world' }),
      listPendingReview: jest
        .fn()
        .mockResolvedValue({ data: [], pageInfo: { nextCursor: null } }),
      reviewThread: jest.fn().mockResolvedValue({ slug: 'hello-world' }),
    };
    service = new AdminForumService(threads as unknown as ForumThreadsService);
  });

  it('delegates to ForumThreadsService.setOfficial with the same args', async () => {
    const result = await service.setThreadOfficial('hello-world', admin, true);

    expect(threads.setOfficial).toHaveBeenCalledWith(
      'hello-world',
      admin,
      true,
    );
    expect(result).toEqual({ slug: 'hello-world' });
  });

  it('delegates the review queue read', async () => {
    await service.listReviewQueue(moderator, 'cursor-1', 25);

    expect(threads.listPendingReview).toHaveBeenCalledWith(
      moderator,
      'cursor-1',
      25,
    );
  });

  it('passes each queue row through with its community, or null for none', async () => {
    // `ForumThreadsService.listPendingReview` loads the page's communities in
    // one query; this service hands its rows to the admin page unchanged.
    const rows = [
      {
        slug: 'hike-sunday',
        community: { slug: 'lisbon-hikers', name: 'Lisbon Hikers' },
      },
      { slug: 'global-question', community: null },
    ];
    threads.listPendingReview.mockResolvedValue({
      data: rows,
      pageInfo: { nextCursor: null, hasMore: false },
    } as unknown as Awaited<
      ReturnType<ForumThreadsService['listPendingReview']>
    >);

    const page = await service.listReviewQueue(moderator, undefined, 20);

    expect(page.data.map((row) => row.community)).toEqual([
      { slug: 'lisbon-hikers', name: 'Lisbon Hikers' },
      null,
    ]);
  });

  it("translates the DTO's verb into the service's approve flag", async () => {
    // The wire says `approve`/`reject`; the service writes `review_state`. The
    // translation happens exactly here so there is no third vocabulary.
    await service.reviewThread('hello-world', moderator, {
      decision: 'approve',
    });
    expect(threads.reviewThread).toHaveBeenCalledWith(
      'hello-world',
      moderator,
      true,
      undefined,
    );

    await service.reviewThread('hello-world', moderator, {
      decision: 'reject',
      note: 'Not yet.',
    });
    expect(threads.reviewThread).toHaveBeenCalledWith(
      'hello-world',
      moderator,
      false,
      'Not yet.',
    );
  });
});
