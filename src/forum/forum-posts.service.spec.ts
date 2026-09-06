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
    // A reply, not the opening post: only replies move `replyCount`.
    isOp: false,
    createdAt: new Date(),
    editedAt: null as Date | null,
    deletedAt: null as Date | null,
  };
  // `updatePostBody` now snapshots + saves inside `posts.manager.transaction`,
  // so the edit row and the mutated post go through the transaction `manager`
  // (not the `edits`/`posts` repos directly). The manager stub runs the
  // callback synchronously and records its writes via `managerSave`.
  const managerSave = jest.fn().mockImplementation((row: unknown) => row);
  // `tombstonePost`/`restorePost` now run inside the same transaction too: the
  // tombstone, the released accepted-answer mark and the thread's `replyCount`
  // describe one fact and commit together (ENG-132).
  const managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    create: jest
      .fn()
      .mockImplementation((_entity: unknown, row: unknown) => row),
    save: managerSave,
    update: managerUpdate,
  };
  const posts = {
    findOne: jest.fn().mockResolvedValue(post),
    save: jest.fn().mockImplementation((savedPost: unknown) => savedPost),
    manager: {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
      // `mapOne` reads the thread's accepted-answer pointer through the
      // entity manager; default to "this thread has no accepted answer".
      findOne: jest.fn().mockResolvedValue(null),
      // `tombstonePost` releases the accepted-answer mark the same way.
      update: jest.fn().mockResolvedValue({ affected: 0 }),
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
  return {
    service,
    post,
    posts,
    edits,
    byUserIds,
    notifications,
    managerSave,
    managerUpdate,
  };
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
    const { service, managerSave } = build();
    await service.tombstonePost('p1', mod);
    expect(managerSave).toHaveBeenCalledWith(
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
    const { service, post, managerSave } = build();
    post.deletedAt = new Date();
    await service.restorePost('p1', mod);
    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: null }),
    );
  });
});

// --- ENG-132: a tombstoned reply stops being counted -------------------------
// `replyCount` was only ever incremented (by `markActivity` on each new reply),
// so a thread whose three replies had all been withdrawn went on advertising
// "3 replies" on /forum and in the reply bar while opening it showed three
// tombstones.
describe('ForumPostsService reply count on delete/restore', () => {
  const replyCountUpdate = (
    managerUpdate: jest.Mock,
  ): [unknown, unknown, Record<string, unknown>] | undefined =>
    (
      managerUpdate.mock.calls as Array<
        [unknown, unknown, Record<string, unknown>]
      >
    ).find((call) => 'replyCount' in call[2]);

  it('decrements the thread reply count when a reply is tombstoned', async () => {
    const { service, managerUpdate } = build();

    await service.tombstonePost('p1', author);

    const call = replyCountUpdate(managerUpdate);
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ id: 't1' });
    // Clamped, never a bare `- 1`: the counter is denormalized and has drifted
    // before, and "-1 replies" is worse than a stale count.
    expect(String((call?.[2].replyCount as () => string)())).toContain(
      'GREATEST',
    );
  });

  it('increments it again when the reply is restored', async () => {
    const { service, post, managerUpdate } = build();
    post.deletedAt = new Date();

    await service.restorePost('p1', author);

    const call = replyCountUpdate(managerUpdate);
    expect(String((call?.[2].replyCount as () => string)())).toBe(
      '"reply_count" + 1',
    );
  });

  it('leaves the count alone when the tombstoned post is the OPENING post', async () => {
    const { service, post, managerUpdate } = build();
    // Withdrawing a whole thread tombstones its OP (`deleteThread`), and the OP
    // has never been counted as a reply — decrementing there would corrupt the
    // count of the thread being withdrawn.
    post.isOp = true;

    await service.tombstonePost('p1', author);

    expect(replyCountUpdate(managerUpdate)).toBeUndefined();
  });

  it('tombstone and count move inside ONE transaction', async () => {
    const { service, posts } = build();

    await service.tombstonePost('p1', author);

    expect(posts.manager.transaction).toHaveBeenCalledTimes(1);
  });
});

// `vote()` runs entirely on the transaction `manager` (findOne / insert
// builder / increment / decrement / delete / update), so this harness stubs a
// manager whose `increment`/`decrement` mutate the shared `post` object — the
// re-read inside `vote()` then reflects the toggled count, exactly like the DB.
function buildVote(options: {
  isOp: boolean;
  voteCount: number;
  // ENG-133 overrides — every one of these used to be unchecked at this
  // endpoint, so each has a test below proving it now refuses.
  authorId?: string;
  deletedAt?: Date | null;
  isBlocked?: boolean;
  moderation?: { hidden: boolean; removed: boolean };
  threadVisible?: boolean;
}) {
  const post = {
    id: 'p1',
    threadId: 't1',
    authorId: options.authorId ?? 'author-1',
    body: 'op',
    voteCount: options.voteCount,
    isOp: options.isOp,
    createdAt: new Date(),
    editedAt: null as Date | null,
    deletedAt: options.deletedAt ?? (null as Date | null),
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
    // `assertCanVote` point-loads the post before the transaction opens.
    findOne: jest.fn().mockResolvedValue(post),
    manager: {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    },
  };
  // The thread-visibility gate: `loadByIdOr404` throws exactly as it does for a
  // withdrawn thread, a blocked thread author or a Private community's thread
  // read by somebody off the roster.
  const loadByIdOr404 = jest.fn(() =>
    options.threadVisible === false
      ? Promise.reject(new NotFoundException('Thread not found'))
      : Promise.resolve({ id: 't1' }),
  );
  const isBlockedEitherWay = jest
    .fn()
    .mockResolvedValue(options.isBlocked ?? false);
  const statesForAnyType = jest
    .fn()
    .mockResolvedValue(
      options.moderation
        ? new Map([['p1', options.moderation]])
        : new Map<string, unknown>(),
    );
  const service = new ForumPostsService(
    posts as never,
    {} as never, // votes repo — unused by vote() (it deletes via the manager)
    {} as never, // profiles
    { markActivity: jest.fn(), loadOr404: jest.fn(), loadByIdOr404 } as never,
    { excludeHidden: jest.fn(), isBlockedEitherWay } as never,
    {} as never, // edits
    {} as never, // mentions
    { statesForAnyType } as never,
    {
      subscribe: jest.fn(),
      subscriberIdsToNotify: jest.fn().mockResolvedValue([]),
    } as never, // subscriptions
  );
  return { service, post, threadUpdate, loadByIdOr404 };
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

// --- ENG-133: the vote endpoint had no gates at all --------------------------
// It loaded the post by id and voted. No visibility check, no self-vote guard,
// on the one endpoint that moves a ranking — and `top` is a real ranked sort
// now (PRD-161), so the payoff for abusing it went up.
describe('ForumPostsService.vote authorization', () => {
  it('refuses an author voting on their own post', async () => {
    const { service } = buildVote({
      isOp: true,
      voteCount: 0,
      authorId: 'author-1',
    });

    await expect(service.vote('p1', 'author-1', 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses an author CLEARING a self-vote too, so nothing is left to clear', async () => {
    const { service } = buildVote({
      isOp: true,
      voteCount: 1,
      authorId: 'author-1',
    });

    await expect(service.vote('p1', 'author-1', 0)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a voter a block stands between, in either direction', async () => {
    const { service } = buildVote({
      isOp: true,
      voteCount: 0,
      isBlocked: true,
    });

    await expect(service.vote('p1', 'voter-1', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a vote in a thread the voter cannot read', async () => {
    // Withdrawn thread, blocked thread author, or a Private community the
    // voter is not on the roster of: all one gate, `loadByIdOr404`.
    const { service, loadByIdOr404 } = buildVote({
      isOp: true,
      voteCount: 0,
      threadVisible: false,
    });

    await expect(service.vote('p1', 'voter-1', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(loadByIdOr404).toHaveBeenCalledWith('t1', 'voter-1');
  });

  it('refuses a vote on a tombstoned post', async () => {
    const { service } = buildVote({
      isOp: false,
      voteCount: 0,
      deletedAt: new Date(),
    });

    await expect(service.vote('p1', 'voter-1', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a vote on a post under a moderator takedown', async () => {
    const { service } = buildVote({
      isOp: false,
      voteCount: 0,
      moderation: { hidden: true, removed: false },
    });

    await expect(service.vote('p1', 'voter-1', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('still lets an unrelated member vote on a visible post', async () => {
    const { service } = buildVote({ isOp: false, voteCount: 0 });

    await expect(service.vote('p1', 'voter-1', 1)).resolves.toEqual({
      voteCount: 1,
      myVote: 1,
    });
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

// --- C5 / ENG-130 + C6 / PRD-162: what a page of posts actually contains -----
// The thread page took the first post of page one AS the opening post. The
// server drops the OP from that page when its author is muted by the viewer, or
// when a moderator hid it and the viewer is not staff — so the first REPLY slid
// into the OP card and was read as the question, wearing that replier's name,
// edit flags and permissions, while disappearing from the reply list.
function buildListPosts(options: {
  opPost?: Record<string, unknown> | null;
  hiddenAuthorIds?: string[];
  opModeration?: { hidden: boolean; removed: boolean };
  rootRows?: Array<Record<string, unknown>>;
  descendantIds?: string[];
  descendantRows?: Array<Record<string, unknown>>;
  acceptedPostId?: string | null;
  role?: string;
}) {
  const makeRow = (row: Record<string, unknown>): Record<string, unknown> => ({
    id: 'post-1',
    parentPostId: null,
    authorId: 'author-1',
    body: 'text',
    image: null,
    voteCount: 0,
    isOp: false,
    threadId: 't1',
    createdAt: new Date('2026-07-23T10:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    ...row,
  });

  const opPost =
    options.opPost === null
      ? null
      : makeRow({ id: 'op-1', isOp: true, ...(options.opPost ?? {}) });
  const rootRows = (options.rootRows ?? []).map(makeRow);
  const descendantRows = (options.descendantRows ?? []).map(makeRow);

  // `getMany` answers in call order: the root stream first, then the descendant
  // load. `getOne` answers the accepted-answer hoist.
  const getManyQueue = [rootRows, descendantRows];
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'take',
    'limit',
    'offset',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn(() =>
    Promise.resolve(getManyQueue.shift() ?? []),
  );
  queryBuilder.getOne = jest.fn().mockResolvedValue(null);

  const posts = {
    createQueryBuilder: jest.fn(() => queryBuilder),
    findOne: jest.fn().mockResolvedValue(opPost),
    manager: {
      query: jest
        .fn()
        .mockResolvedValue((options.descendantIds ?? []).map((id) => ({ id }))),
    },
  };
  const votes = { find: jest.fn().mockResolvedValue([]) };
  const blockFilter = {
    excludeHidden: jest.fn(),
    hiddenUserIds: jest
      .fn()
      .mockResolvedValue(new Set(options.hiddenAuthorIds ?? [])),
  };
  const contentModeration = {
    statesForAnyType: jest
      .fn()
      .mockResolvedValue(
        options.opModeration && opPost
          ? new Map([[String(opPost.id), options.opModeration]])
          : new Map<string, unknown>(),
      ),
  };
  const loadOr404 = jest.fn().mockResolvedValue({
    id: 't1',
    slug: 'hello',
    acceptedPostId: options.acceptedPostId ?? null,
  });
  jest.spyOn(MemberLookup.prototype, 'byUserIds').mockResolvedValue(new Map());

  const service = new ForumPostsService(
    posts as never,
    votes as never,
    {} as never,
    { loadOr404, markActivity: jest.fn() } as never,
    blockFilter as never,
    {} as never,
    {} as never,
    contentModeration as never,
    {} as never,
  );
  const viewer = {
    userId: 'viewer-1',
    email: '',
    status: 'active',
    role: options.role ?? 'member',
  };
  return { service, viewer, posts, queryBuilder };
}

describe('ForumPostsService.listPosts opening post', () => {
  it('leads page one with the OP and reports it available', async () => {
    const { service, viewer } = buildListPosts({
      rootRows: [{ id: 'r1' }],
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.opAvailable).toBe(true);
    expect(page.data[0]?.id).toBe('op-1');
    expect(page.data[0]?.isOp).toBe(true);
    expect(page.data[1]?.isOp).toBe(false);
  });

  it('reports the OP unavailable when the viewer muted its author, and does not promote a reply into its place', async () => {
    const { service, viewer } = buildListPosts({
      hiddenAuthorIds: ['author-1'],
      rootRows: [{ id: 'r1', authorId: 'someone-else' }],
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.opAvailable).toBe(false);
    // The first post of the page is a REPLY, and it says so.
    expect(page.data[0]?.id).toBe('r1');
    expect(page.data[0]?.isOp).toBe(false);
  });

  it('reports the OP unavailable to a member when a moderator hid it', async () => {
    const { service, viewer } = buildListPosts({
      opModeration: { hidden: true, removed: false },
      rootRows: [],
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.opAvailable).toBe(false);
  });

  it('still shows that same OP to a moderator', async () => {
    const { service, viewer } = buildListPosts({
      opModeration: { hidden: true, removed: false },
      role: 'moderator',
      rootRows: [],
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.opAvailable).toBe(true);
    expect(page.data[0]?.isOp).toBe(true);
  });

  it('keeps a REMOVED opening post available, as a tombstone', async () => {
    // A removed post survives as `[removed]` for everyone; that is a different
    // thing from having no opening post at all.
    const { service, viewer } = buildListPosts({
      opModeration: { hidden: false, removed: true },
      rootRows: [],
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.opAvailable).toBe(true);
    expect(page.data[0]?.isOp).toBe(true);
    expect(page.data[0]?.body).toBe('');
  });

  it('reports the OP unavailable when the thread carries no opening post at all', async () => {
    const { service, viewer } = buildListPosts({ opPost: null, rootRows: [] });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.opAvailable).toBe(false);
  });

  it('does not hoist the OP onto a later page, but still reports availability', async () => {
    const { service, viewer } = buildListPosts({ rootRows: [{ id: 'r1' }] });

    const page = await service.listPosts('hello', viewer, 'cursor-1', 20);

    expect(page.opAvailable).toBe(true);
    expect(page.data.some((post) => post.isOp)).toBe(false);
  });
});

describe('ForumPostsService.listPosts reply tree', () => {
  it('ships each root reply with its whole subtree, so a child never arrives before its parent', async () => {
    const { service, viewer, posts } = buildListPosts({
      rootRows: [{ id: 'r1' }],
      descendantIds: ['c1'],
      descendantRows: [{ id: 'c1', parentPostId: 'r1' }],
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(posts.manager.query).toHaveBeenCalledTimes(1);
    expect(page.data.map((post) => post.id)).toEqual(['op-1', 'r1', 'c1']);
  });

  it('treats a reply parented to the OP as a root, never as an unreachable descendant', async () => {
    const { service, viewer, queryBuilder } = buildListPosts({
      rootRows: [{ id: 'r1', parentPostId: 'op-1' }],
    });

    await service.listPosts('hello', viewer, undefined, 20);

    const rootPredicates = (
      queryBuilder.andWhere as jest.Mock<unknown, unknown[]>
    ).mock.calls.map((call) => String(call[0]));
    expect(
      rootPredicates.some((predicate) =>
        predicate.includes('p.parentPostId = :rootOpPostId'),
      ),
    ).toBe(true);
  });

  it('never returns one post twice when the accepted answer is also a descendant', async () => {
    const { service, viewer, queryBuilder } = buildListPosts({
      acceptedPostId: 'c1',
      rootRows: [{ id: 'r1' }],
      descendantIds: ['c1'],
      descendantRows: [{ id: 'c1', parentPostId: 'r1' }],
    });
    (queryBuilder.getOne as jest.Mock).mockResolvedValue({
      id: 'c1',
      parentPostId: 'r1',
      authorId: 'author-1',
      threadId: 't1',
      body: 'answer',
      image: null,
      voteCount: 0,
      isOp: false,
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
      editedAt: null,
      deletedAt: null,
      deletedById: null,
    });

    const page = await service.listPosts('hello', viewer, undefined, 20);

    expect(page.data.filter((post) => post.id === 'c1')).toHaveLength(1);
    // Hoisted: the accepted answer leads the replies, right behind the OP.
    expect(page.data.map((post) => post.id)).toEqual(['op-1', 'c1', 'r1']);
  });
});
