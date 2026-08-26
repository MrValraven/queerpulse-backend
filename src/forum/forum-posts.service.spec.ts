import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MemberLookup } from '../common/member-ref';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumPostsService } from './forum-posts.service';

// Minimal fake repositories; only the paths exercised below are stubbed.
function build() {
  const post = {
    id: 'p1',
    threadId: 't1',
    authorId: 'author-1',
    body: 'original',
    voteCount: 0,
    createdAt: new Date(),
    editedAt: null as Date | null,
    deletedAt: null as Date | null,
  };
  // `updatePostBody` now snapshots + saves inside `posts.manager.transaction`,
  // so the edit row and the mutated post go through the transaction `manager`
  // (not the `edits`/`posts` repos directly). The manager stub runs the
  // callback synchronously and records its writes via `managerSave`.
  const managerSave = jest.fn().mockImplementation((row: unknown) => row);
  const manager = {
    create: jest
      .fn()
      .mockImplementation((_entity: unknown, row: unknown) => row),
    save: managerSave,
  };
  const posts = {
    findOne: jest.fn().mockResolvedValue(post),
    save: jest.fn().mockImplementation((savedPost: unknown) => savedPost),
    manager: {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    },
  };
  const votes = { findOne: jest.fn().mockResolvedValue(null) };
  const edits = {
    create: jest.fn().mockImplementation((row: unknown) => row),
    save: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };
  const profiles = {} as never;
  const notifications = { createForRecipients: jest.fn() };
  const byUserIds = jest
    .spyOn(MemberLookup.prototype, 'byUserIds')
    .mockResolvedValue(new Map());
  const service = new ForumPostsService(
    posts as never,
    votes as never,
    profiles,
    { markActivity: jest.fn(), loadOr404: jest.fn() } as never,
    { excludeHidden: jest.fn() } as never,
    edits as never,
    notifications as never,
    {
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    } as never,
    // SOC-13 thread following — stubbed so the reply path can auto-subscribe
    // and fan out without a repository.
    {
      subscribe: jest.fn(),
      subscriberIdsToNotify: jest.fn().mockResolvedValue([]),
    } as never,
  );
  return { service, post, posts, edits, byUserIds, notifications, managerSave };
}

const author = {
  userId: 'author-1',
  email: '',
  status: 'active',
  role: 'member',
};
const mod = { userId: 'mod-1', email: '', status: 'active', role: 'moderator' };
const stranger = { userId: 'x', email: '', status: 'active', role: 'member' };

describe('ForumPostsService authorization', () => {
  it('updatePostBody: non-author is forbidden', async () => {
    const { service } = build();
    await expect(
      service.updatePostBody('p1', mod, 'hack'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updatePostBody: author snapshots a revision then edits', async () => {
    const { service, managerSave } = build();
    await service.updatePostBody('p1', author, 'new body');
    // Both writes run through the transaction manager: the edit snapshot first,
    // then the mutated post.
    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({
        previousBody: 'original',
        previousTitle: null,
      }),
    );
    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'new body',
        editedAt: expect.any(Date) as unknown,
      }),
    );
  });

  it('updatePostBody: editing a deleted post 404s', async () => {
    const { service, post } = build();
    post.deletedAt = new Date();
    await expect(
      service.updatePostBody('p1', author, 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('tombstonePost: moderator may delete another member post', async () => {
    const { service, posts } = build();
    await service.tombstonePost('p1', mod);
    expect(posts.save).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) as unknown }),
    );
  });

  it('tombstonePost: stranger is forbidden', async () => {
    const { service } = build();
    await expect(service.tombstonePost('p1', stranger)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('restorePost: clears the tombstone for staff', async () => {
    const { service, post, posts } = build();
    post.deletedAt = new Date();
    await service.restorePost('p1', mod);
    expect(posts.save).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: null }),
    );
  });
});

// `vote()` runs entirely on the transaction `manager` (findOne / insert
// builder / increment / decrement / delete / update), so this harness stubs a
// manager whose `increment`/`decrement` mutate the shared `post` object — the
// re-read inside `vote()` then reflects the toggled count, exactly like the DB.
function buildVote(options: { isOp: boolean; voteCount: number }) {
  const post = {
    id: 'p1',
    threadId: 't1',
    authorId: 'author-1',
    body: 'op',
    voteCount: options.voteCount,
    isOp: options.isOp,
    createdAt: new Date(),
    editedAt: null as Date | null,
    deletedAt: null as Date | null,
  };
  // Chainable stub for `.insert().into().values().orIgnore().execute()`; a
  // single `raw` row means "this call did the insert", so `vote()` increments.
  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [{ id: 'v1' }] }),
  };
  const threadUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    findOne: jest.fn().mockResolvedValue(post),
    createQueryBuilder: jest.fn().mockReturnValue(insertBuilder),
    increment: jest
      .fn()
      .mockImplementation(
        (_entity: unknown, _where: unknown, _column: string, by: number) => {
          post.voteCount += by;
          return Promise.resolve({ affected: 1 });
        },
      ),
    decrement: jest
      .fn()
      .mockImplementation(
        (_entity: unknown, _where: unknown, _column: string, by: number) => {
          post.voteCount -= by;
          return Promise.resolve({ affected: 1 });
        },
      ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: threadUpdate,
  };
  const posts = {
    manager: {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    },
  };
  const service = new ForumPostsService(
    posts as never,
    {} as never, // votes repo — unused by vote() (it deletes via the manager)
    {} as never, // profiles
    { markActivity: jest.fn(), loadOr404: jest.fn() } as never,
    { excludeHidden: jest.fn() } as never,
    {} as never, // edits
    {} as never, // mentions
    { statesForAnyType: jest.fn() } as never,
    {
      subscribe: jest.fn(),
      subscriberIdsToNotify: jest.fn().mockResolvedValue([]),
    } as never, // subscriptions
  );
  return { service, post, threadUpdate };
}

describe('ForumPostsService vote → op_vote_count denorm', () => {
  it('upvoting the OP mirrors the new count onto the thread', async () => {
    const { service, threadUpdate } = buildVote({ isOp: true, voteCount: 0 });
    const result = await service.vote('p1', 'voter-1', 1);
    expect(result).toEqual({ voteCount: 1, myVote: 1 });
    expect(threadUpdate).toHaveBeenCalledWith(
      ForumThread,
      { id: 't1' },
      { opVoteCount: 1 },
    );
  });

  it('upvoting a non-OP reply leaves the thread untouched', async () => {
    const { service, threadUpdate } = buildVote({ isOp: false, voteCount: 0 });
    const result = await service.vote('p1', 'voter-1', 1);
    expect(result).toEqual({ voteCount: 1, myVote: 1 });
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it('clearing a vote on the OP decrements the mirrored count', async () => {
    const { service, threadUpdate } = buildVote({ isOp: true, voteCount: 1 });
    const result = await service.vote('p1', 'voter-1', 0);
    expect(result).toEqual({ voteCount: 0, myVote: 0 });
    expect(threadUpdate).toHaveBeenCalledWith(
      ForumThread,
      { id: 't1' },
      { opVoteCount: 0 },
    );
  });
});

// --- SOC-08: reply bodies as a search type -----------------------------------
// Its own builder: the query-builder path below is untouched by the
// authorization fakes above, and the visibility gates are the whole point of
// these tests.
function buildSearch() {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  const posts = { createQueryBuilder: jest.fn(() => queryBuilder) };
  const blockFilter = { excludeHidden: jest.fn() };
  const service = new ForumPostsService(
    posts as never,
    {} as never,
    {} as never,
    {} as never,
    blockFilter as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const andWhereCalls = (): unknown[][] =>
    (queryBuilder.andWhere as jest.Mock<unknown, unknown[]>).mock.calls;
  const predicates = () =>
    andWhereCalls()
      .map((call) => String(call[0]))
      .join('\n');
  return { service, queryBuilder, blockFilter, predicates, andWhereCalls };
}

describe('ForumPostsService.searchByText visibility', () => {
  it('drops posts whose author the viewer blocked or muted', async () => {
    const { service, queryBuilder, blockFilter } = buildSearch();

    await service.searchByText('viewer-1', 'gp', 6);

    expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
      queryBuilder,
      'viewer-1',
      '"p"."author_id"',
    );
  });

  it('drops posts inside a thread whose AUTHOR the viewer blocked or muted', async () => {
    const { service, predicates } = buildSearch();

    await service.searchByText('viewer-1', 'gp', 6);

    const sql = predicates();
    expect(sql).toContain('"__thread_author_block"');
    expect(sql).toContain('"__thread_author_mute"');
    expect(sql).toContain('"t"."author_id"');
  });

  it('never surfaces a Private community thread to a non-member', async () => {
    const { service, predicates, andWhereCalls } = buildSearch();

    await service.searchByText('viewer-1', 'gp', 6);

    expect(predicates()).toContain('"__search_com"."access_tier" != ');
    expect(predicates()).toContain(
      '"__search_mem"."user_id" = :searchViewerId',
    );
    const communityCall = andWhereCalls().find((call) =>
      String(call[0]).includes('__search_com'),
    );
    expect(communityCall?.[1]).toEqual({ searchPrivateTier: 'private' });
  });

  it('never surfaces a tombstoned post body', async () => {
    const { service, predicates } = buildSearch();

    await service.searchByText('viewer-1', 'gp', 6);

    expect(predicates()).toContain('p.deletedAt IS NULL');
  });

  it('drops both hidden AND removed moderation subjects, under either taxonomy code', async () => {
    const { service, predicates, andWhereCalls } = buildSearch();

    await service.searchByText('viewer-1', 'gp', 6);

    const sql = predicates();
    // A read path keeps a removed post as a visible `[removed]` tombstone.
    // Search must not: surfacing it means surfacing the text a moderator took
    // down.
    expect(sql).toContain('"__search_moderation"."hidden_at" IS NOT NULL');
    expect(sql).toContain('"__search_moderation"."removed_at" IS NOT NULL');
    const moderationCall = andWhereCalls().find((call) =>
      String(call[0]).includes('__search_moderation'),
    );
    expect(moderationCall?.[1]).toEqual({
      searchModerationSubjectTypes: ['post', 'reply'],
    });
  });

  it('matches accent-folded full text and ranks by relevance', async () => {
    const { service, queryBuilder } = buildSearch();

    await service.searchByText('viewer-1', 'sao', 6);

    const [predicate, parameters] = (queryBuilder.where as jest.Mock).mock
      .calls[0] as [string, Record<string, string>];
    expect(predicate).toContain('websearch_to_tsquery');
    expect(predicate).toContain('translate(lower(');
    expect(parameters.searchTerm).toBe('sao');
    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      expect.stringContaining('ts_rank'),
      'search_rank',
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('search_rank', 'DESC');
  });

  it('pages with a flat limit/offset', async () => {
    const { service, queryBuilder } = buildSearch();

    await service.searchByText('viewer-1', 'gp', 11, 20);

    expect(queryBuilder.limit).toHaveBeenCalledWith(11);
    expect(queryBuilder.offset).toHaveBeenCalledWith(20);
  });

  it('returns the matching part of the reply, keyed to its thread', async () => {
    const { service, queryBuilder } = buildSearch();
    const body = `${'x'.repeat(400)} the GP at the health centre was wonderful ${'y'.repeat(400)}`;
    (queryBuilder.getRawMany as jest.Mock).mockResolvedValue([
      {
        threadSlug: 'gp-lisbon',
        threadTitle: 'Trans-friendly GP in Lisbon?',
        threadCategory: 'health',
        postBody: body,
      },
    ]);

    const rows = await service.searchByText('viewer-1', 'health centre', 6);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadSlug).toBe('gp-lisbon');
    expect(rows[0]?.threadTitle).toBe('Trans-friendly GP in Lisbon?');
    expect(rows[0]?.excerpt).toContain('health centre');
    expect(rows[0]?.excerpt.length).toBeLessThanOrEqual(162);
  });

  it('centres the excerpt on an accented match found by the folded query', async () => {
    const { service, queryBuilder } = buildSearch();
    const body = `${'x'.repeat(400)} fui ao centro de saúde em São Bento ${'y'.repeat(400)}`;
    (queryBuilder.getRawMany as jest.Mock).mockResolvedValue([
      {
        threadSlug: 'sao-bento',
        threadTitle: 'Clinicas',
        threadCategory: 'health',
        postBody: body,
      },
    ]);

    const rows = await service.searchByText('viewer-1', 'Sao Bento', 6);

    expect(rows[0]?.excerpt).toContain('São Bento');
  });
});
