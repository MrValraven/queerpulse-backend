import { MemberLookup } from '../common/member-ref';
import { HttpException } from '@nestjs/common';
import { fundingException } from './forum-funding';
import { ForumFundingService } from './forum-funding.service';
import { ForumPostsService } from './forum-posts.service';

const author = {
  userId: 'author-1',
  email: '',
  status: 'active',
  role: 'member',
};

// The real payment-details rule: `assertAskTextAllowed` is pure, so none of
// the funding service's repositories are reached.
const fundingRules = new ForumFundingService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);

// The code a coded funding error carries, or undefined when nothing threw.
async function fundingCodeOf(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  return undefined;
}

function build(isOp: boolean, threadKind: string | null = null) {
  const post = {
    id: 'post-1',
    threadId: 'thread-1',
    parentPostId: null,
    authorId: 'author-1',
    body: 'Everything is explained on the GoFundMe page.',
    image: null,
    voteCount: 0,
    isOp,
    createdAt: new Date('2026-10-05T09:00:00.000Z'),
    editedAt: null as Date | null,
    deletedAt: null as Date | null,
    deletedById: null,
  };
  const managerSave = jest.fn().mockImplementation((row: unknown) => row);
  const manager = {
    create: jest
      .fn()
      .mockImplementation((_entity: unknown, row: unknown) => row),
    save: managerSave,
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const posts = {
    findOne: jest.fn().mockResolvedValue(post),
    manager: {
      transaction: jest.fn(
        async (
          callback: (transactionManager: typeof manager) => Promise<unknown>,
        ) => callback(manager),
      ),
      // The thread behind the post: its `kind` decides the reply rule, and
      // `mapOne` reads the accepted-answer pointer from the same row.
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'thread-1', kind: threadKind }),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      find: jest.fn().mockResolvedValue([]),
    },
  };
  const threadsService = {
    markActivity: jest.fn(),
    loadOr404: jest.fn(),
    applyOpBodyEditRules: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(MemberLookup.prototype, 'byUserIds').mockResolvedValue(new Map());
  const service = new ForumPostsService(
    posts as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    {} as never,
    threadsService as never,
    { excludeHidden: jest.fn() } as never,
    {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    } as never,
    {} as never,
    { statesForAnyType: jest.fn().mockResolvedValue(new Map()) } as never,
    { subscribe: jest.fn(), subscriberIdsToNotify: jest.fn() } as never,
    fundingRules,
  );
  return { service, threadsService, managerSave, manager };
}

describe('ForumPostsService.updatePostBody funding rules (P4)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs the funding rules on an opening-post edit before the post is saved', async () => {
    const { service, threadsService, managerSave, manager } = build(true);
    let savesBeforeRules = -1;
    threadsService.applyOpBodyEditRules.mockImplementation(() => {
      savesBeforeRules = managerSave.mock.calls.length;
      return Promise.resolve();
    });

    await service.updatePostBody(
      'post-1',
      author,
      'Updated: the clinic confirmed the date.',
    );

    expect(threadsService.applyOpBodyEditRules).toHaveBeenCalledWith(
      manager,
      'thread-1',
      'Updated: the clinic confirmed the date.',
      false,
    );
    // Only the edit snapshot was written before the rules ran.
    expect(savesBeforeRules).toBe(1);
    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Updated: the clinic confirmed the date.',
      }),
    );
  });

  it('lets a payment-details refusal stop the edit before the post is saved', async () => {
    const { service, threadsService, managerSave } = build(true);
    threadsService.applyOpBodyEditRules.mockRejectedValue(
      fundingException('funding_payment_details_in_body'),
    );

    await expect(
      service.updatePostBody(
        'post-1',
        author,
        'IBAN: PT50 0002 0123 1234 5678 9015 4',
      ),
    ).rejects.toThrow();
    expect(managerSave).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'IBAN: PT50 0002 0123 1234 5678 9015 4',
      }),
    );
  });

  it('treats a moderator editing their own opening post as its author', async () => {
    const { service, threadsService, manager } = build(true);

    await service.updatePostBody(
      'post-1',
      { ...author, role: 'moderator' },
      'Updated: the clinic confirmed the date.',
    );

    expect(threadsService.applyOpBodyEditRules).toHaveBeenCalledWith(
      manager,
      'thread-1',
      'Updated: the clinic confirmed the date.',
      false,
    );
  });

  it('skips the funding rules for a reply', async () => {
    const { service, threadsService } = build(false);

    await service.updatePostBody('post-1', author, 'A reply, edited');

    expect(threadsService.applyOpBodyEditRules).not.toHaveBeenCalled();
  });
});

describe('ForumPostsService reply funding rules (I1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildReply(threadKind: string | null) {
    const manager = {
      create: jest
        .fn()
        .mockImplementation((_entity: unknown, row: unknown) => row),
      save: jest.fn().mockImplementation((row: Record<string, unknown>) =>
        Promise.resolve({
          id: 'reply-1',
          createdAt: new Date('2026-10-05T10:00:00.000Z'),
          editedAt: null,
          deletedAt: null,
          deletedById: null,
          ...row,
        }),
      ),
    };
    const posts = {
      manager: {
        transaction: jest.fn(
          async (callback: (transactionManager: typeof manager) => unknown) =>
            callback(manager),
        ),
      },
    };
    const threadsService = {
      loadOr404: jest.fn().mockResolvedValue({
        id: 'thread-1',
        slug: 'help-ana',
        authorId: 'author-1',
        kind: threadKind,
        isLocked: false,
        closesAt: null,
        acceptedPostId: null,
      }),
      assertCanReplyInThread: jest.fn().mockResolvedValue(undefined),
      markActivity: jest.fn().mockResolvedValue(undefined),
    };
    const mentions = {
      notify: jest.fn().mockResolvedValue(new Set<string>()),
      notifyThreadReply: jest.fn().mockResolvedValue(undefined),
      notifyParentReply: jest.fn().mockResolvedValue(undefined),
      forumThreadAudience: jest.fn((_threadSlug: string, userIds: string[]) =>
        Promise.resolve(new Set(userIds)),
      ),
    };
    const subscriptions = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      subscriberIdsToNotify: jest.fn().mockResolvedValue([]),
    };
    jest
      .spyOn(MemberLookup.prototype, 'byUserIds')
      .mockResolvedValue(new Map());
    const service = new ForumPostsService(
      posts as never,
      {} as never,
      {} as never,
      threadsService as never,
      {} as never,
      {} as never,
      mentions as never,
      {} as never,
      subscriptions as never,
      fundingRules,
    );
    return { service, manager, posts };
  }

  const replier = {
    userId: 'replier-1',
    email: '',
    status: 'active',
    role: 'member',
  };

  it('refuses a reply carrying a Portuguese mobile under a fundraiser, before any write', async () => {
    const { service, posts } = buildReply('ask');

    expect(
      await fundingCodeOf(
        service.reply('help-ana', replier, 'MB Way 912 345 678'),
      ),
    ).toBe('funding_payment_details_in_body');
    expect(posts.manager.transaction).not.toHaveBeenCalled();
  });

  it('refuses a reply carrying an IBAN under a fundraiser', async () => {
    const { service } = buildReply('ask');

    expect(
      await fundingCodeOf(
        service.reply(
          'help-ana',
          replier,
          'Send it to me instead: PT50 0002 0123 1234 5678 9015 4',
        ),
      ),
    ).toBe('funding_payment_details_in_body');
  });

  it('allows the same reply under an open call', async () => {
    const { service, manager } = buildReply('call');

    await service.reply('help-ana', replier, 'MB Way 912 345 678');

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'MB Way 912 345 678', isOp: false }),
    );
  });

  it('allows a reply under a fundraiser that carries no payment details', async () => {
    const { service, manager } = buildReply('ask');

    await service.reply('help-ana', replier, 'Shared it with my collective!');

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Shared it with my collective!' }),
    );
  });
});

describe('ForumPostsService.updatePostBody reply funding rules (I1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses a reply edit carrying payment details under a fundraiser, before any write', async () => {
    const { service, managerSave, threadsService } = build(false, 'ask');

    expect(
      await fundingCodeOf(
        service.updatePostBody('post-1', author, 'MB Way 912 345 678'),
      ),
    ).toBe('funding_payment_details_in_body');
    expect(managerSave).not.toHaveBeenCalled();
    expect(threadsService.applyOpBodyEditRules).not.toHaveBeenCalled();
  });

  it('allows the same reply edit under an open call', async () => {
    const { service, managerSave } = build(false, 'call');

    await service.updatePostBody('post-1', author, 'MB Way 912 345 678');

    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'MB Way 912 345 678' }),
    );
  });
});
