import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { IsNull } from 'typeorm';
import { ForumThreadFunding } from './entities/forum-thread-funding.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { FORUM_FUNDING_DEADLINE_CHANGED } from './forum.events';
import { ASK_AUTO_END_MS, ResolvedFundingFields } from './forum-funding';
import { ForumFundingService } from './forum-funding.service';
import { VerificationLevel } from '../verification/verification-level';

const NOW = new Date('2026-10-05T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  return undefined;
}

async function asyncCodeOf(
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

const callInput = {
  linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
  funderName: 'Fundação Gulbenkian',
  deadline: '2026-12-01T23:59:00.000Z',
  eligibility: ['individuals'],
  scope: 'national',
};

const resolvedCall: ResolvedFundingFields = {
  kind: 'call',
  linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
  linkHost: 'gulbenkian.pt',
  linkKey: 'gulbenkian.pt/bolsas/arte-queer',
  funderName: 'Fundação Gulbenkian',
  amountMin: null,
  amountMax: null,
  deadline: new Date('2026-12-01T23:59:00.000Z'),
  eligibility: ['individuals'],
  scope: 'national',
  goalAmount: null,
  askPurpose: null,
  beneficiary: null,
  endsAt: null,
};

function makeRow(
  overrides: Partial<ForumThreadFunding> = {},
): ForumThreadFunding {
  return {
    threadId: 'thread-1',
    linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
    linkKey: 'gulbenkian.pt/bolsas/arte-queer',
    updatedAt: new Date('2026-10-01T10:00:00.000Z'),
    funderName: 'Fundação Gulbenkian',
    amountMin: null,
    amountMax: null,
    deadline: new Date('2026-11-01T23:59:00.000Z'),
    eligibility: ['individuals'],
    scope: 'national',
    goalAmount: null,
    askPurpose: null,
    beneficiary: null,
    endsAt: null,
    endedAt: null,
    endedReason: null,
    approvedAt: null,
    ...overrides,
  };
}

const callThread = {
  id: 'thread-1',
  slug: 'arts-grant',
  title: 'Arts grant',
  kind: 'call',
  authorId: 'author-1',
} as ForumThread;

function buildService() {
  const fundingRows = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn((row: ForumThreadFunding) => Promise.resolve(row)),
  };
  const repositoryInTransaction = {
    create: jest.fn((row: Partial<ForumThreadFunding>) => row),
    save: jest.fn((row: Partial<ForumThreadFunding>) => Promise.resolve(row)),
  };
  const manager = {
    getRepository: jest.fn(() => repositoryInTransaction),
    query: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const eventEmitter = { emit: jest.fn() };
  const verification = {
    levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Phone),
    levelsForUsers: jest.fn().mockResolvedValue(new Map()),
  };
  const users = { find: jest.fn().mockResolvedValue([]) };
  const service = new ForumFundingService(
    fundingRows as never,
    eventEmitter as never,
    verification as never,
    users as never,
  );
  return {
    service,
    fundingRows,
    repositoryInTransaction,
    manager,
    eventEmitter,
    verification,
    users,
  };
}

describe('ForumFundingService.resolveForCreate', () => {
  const baseRequest = {
    title: 'Arts grant',
    body: 'Applications close in December',
    isAnonymous: false,
  };

  it('answers null for an ordinary thread with no funding object', () => {
    const { service } = buildService();
    expect(
      service.resolveForCreate(
        {
          ...baseRequest,
          kind: 'question',
          category: 'general',
          funding: undefined,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('refuses a funding object on any other kind', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            ...baseRequest,
            kind: 'question',
            category: 'funding',
            funding: callInput,
          },
          NOW,
        ),
      ),
    ).toBe('funding_details_not_allowed');
  });

  it('refuses a call outside the funding category', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            ...baseRequest,
            kind: 'call',
            category: 'activism',
            funding: callInput,
          },
          NOW,
        ),
      ),
    ).toBe('funding_kind_category_mismatch');
  });

  it('refuses a call with no funding object', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            ...baseRequest,
            kind: 'call',
            category: 'funding',
            funding: undefined,
          },
          NOW,
        ),
      ),
    ).toBe('funding_details_required');
  });

  it('passes a field error through with its own message', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            ...baseRequest,
            kind: 'call',
            category: 'funding',
            funding: { ...callInput, linkUrl: 'http://www.gulbenkian.pt' },
          },
          NOW,
        ),
      ),
    ).toBe('funding_link_invalid');
  });

  // The category is stored as sent and every funding view filters it
  // exactly, so only the canonical spelling may carry a call.
  it('refuses a call in a padded, capitalised funding category', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            ...baseRequest,
            kind: 'call',
            category: ' Funding ',
            funding: callInput,
          },
          NOW,
        ),
      ),
    ).toBe('funding_kind_category_mismatch');
  });

  it('resolves a valid call in the funding category', () => {
    const { service } = buildService();
    expect(
      service.resolveForCreate(
        {
          ...baseRequest,
          kind: 'call',
          category: 'funding',
          funding: callInput,
        },
        NOW,
      ),
    ).toEqual(resolvedCall);
  });
});

describe('ForumFundingService persistence', () => {
  it('inserts the row through the transaction manager with a fresh lifecycle', async () => {
    const { service, manager, repositoryInTransaction } = buildService();

    await service.insertForThread(
      manager as never,
      'thread-1',
      resolvedCall,
      NOW,
    );

    expect(manager.getRepository).toHaveBeenCalledWith(ForumThreadFunding);
    expect(repositoryInTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        linkUrl: 'https://www.gulbenkian.pt/bolsas/arte-queer',
        linkKey: 'gulbenkian.pt/bolsas/arte-queer',
        funderName: 'Fundação Gulbenkian',
        deadline: new Date('2026-12-01T23:59:00.000Z'),
        updatedAt: NOW,
        endedAt: null,
        endedReason: null,
        approvedAt: null,
      }),
    );
    expect(repositoryInTransaction.save).toHaveBeenCalledTimes(1);
  });

  it('reads nothing for an empty page', async () => {
    const { service, fundingRows } = buildService();
    expect(await service.rowsByThread([])).toEqual(new Map());
    expect(fundingRows.find).not.toHaveBeenCalled();
  });

  it('keys a page of rows by thread id in one query', async () => {
    const { service, fundingRows } = buildService();
    fundingRows.find.mockResolvedValue([
      makeRow(),
      makeRow({ threadId: 'thread-2' }),
    ]);

    const rows = await service.rowsByThread([
      'thread-1',
      'thread-2',
      'thread-3',
    ]);

    expect(fundingRows.find).toHaveBeenCalledTimes(1);
    expect([...rows.keys()]).toEqual(['thread-1', 'thread-2']);
  });
});

describe('ForumFundingService edits', () => {
  it('refuses funding details on a thread whose kind carries none', async () => {
    const { service } = buildService();
    expect(
      await asyncCodeOf(
        service.prepareEdit(
          { id: 'thread-1', kind: 'question' },
          callInput,
          NOW,
        ),
      ),
    ).toBe('funding_details_not_allowed');
  });

  it('notices a moved deadline', async () => {
    const { service, fundingRows } = buildService();
    fundingRows.findOne.mockResolvedValue(makeRow());

    const prepared = await service.prepareEdit(callThread, callInput, NOW);

    expect(prepared).toEqual({
      threadId: 'thread-1',
      resolved: resolvedCall,
      previousDeadline: new Date('2026-11-01T23:59:00.000Z'),
      isDeadlineChanged: true,
    });
  });

  it('lets an edit keep a deadline that has already passed', async () => {
    const { service, fundingRows } = buildService();
    const passed = new Date('2026-10-01T23:59:00.000Z');
    fundingRows.findOne.mockResolvedValue(makeRow({ deadline: passed }));

    const prepared = await service.prepareEdit(
      callThread,
      { ...callInput, deadline: passed.toISOString() },
      NOW,
    );

    expect(prepared.isDeadlineChanged).toBe(false);
    expect(prepared.resolved.deadline).toEqual(passed);
  });

  it('saves the replacement and leaves the ask lifecycle columns alone', async () => {
    const { service, manager, repositoryInTransaction } = buildService();

    await service.saveEdit(
      manager as never,
      {
        threadId: 'thread-1',
        resolved: resolvedCall,
        previousDeadline: null,
        isDeadlineChanged: true,
      },
      NOW,
    );

    const savedRow = repositoryInTransaction.create.mock.calls[0]?.[0];
    expect(savedRow).toEqual(
      expect.objectContaining({ threadId: 'thread-1', updatedAt: NOW }),
    );
    expect(savedRow).not.toHaveProperty('endedAt');
    expect(savedRow).not.toHaveProperty('endedReason');
    expect(savedRow).not.toHaveProperty('approvedAt');
  });

  it('announces a moved deadline with the new date', () => {
    const { service, eventEmitter } = buildService();

    service.emitDeadlineChanged(
      callThread,
      {
        threadId: 'thread-1',
        resolved: resolvedCall,
        previousDeadline: new Date('2026-11-01T23:59:00.000Z'),
        isDeadlineChanged: true,
      },
      'author-1',
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      FORUM_FUNDING_DEADLINE_CHANGED,
      {
        threadId: 'thread-1',
        threadSlug: 'arts-grant',
        threadTitle: 'Arts grant',
        authorId: 'author-1',
        editorId: 'author-1',
        deadline: '2026-12-01T23:59:00.000Z',
      },
    );
  });

  it('stays quiet when the deadline did not move', () => {
    const { service, eventEmitter } = buildService();

    service.emitDeadlineChanged(
      callThread,
      {
        threadId: 'thread-1',
        resolved: resolvedCall,
        previousDeadline: resolvedCall.deadline,
        isDeadlineChanged: false,
      },
      'author-1',
    );

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});

const approvedAsk = (): ForumThread =>
  ({
    id: 'thread-1',
    slug: 'help-ana',
    title: 'Help with surgery costs',
    kind: 'ask',
    authorId: 'author-1',
    reviewState: 'approved',
  }) as ForumThread;

const askRow = (overrides: Partial<ForumThreadFunding> = {}) =>
  makeRow({
    linkUrl: 'https://www.gofundme.com/f/help-ana',
    linkKey: 'gofundme.com/f/help-ana',
    funderName: null,
    deadline: null,
    eligibility: [],
    scope: null,
    goalAmount: 1200,
    askPurpose: 'healthcare',
    beneficiary: 'self',
    approvedAt: new Date(NOW.getTime() - DAY_MS),
    ...overrides,
  });

describe('ForumFundingService.resolveForCreate for asks (P4)', () => {
  const askRequest = {
    kind: 'ask',
    category: 'funding',
    title: 'Help with surgery costs',
    body: 'Everything is explained on the GoFundMe page.',
    isAnonymous: false,
    funding: {
      linkUrl: 'https://www.gofundme.com/f/help-ana',
      goalAmount: 1200,
      askPurpose: 'healthcare',
      beneficiary: 'self',
    },
  };

  it('resolves a clean ask', () => {
    const { service } = buildService();
    expect(service.resolveForCreate(askRequest, NOW)).toEqual(
      expect.objectContaining({
        kind: 'ask',
        linkHost: 'gofundme.com',
        goalAmount: 1200,
      }),
    );
  });

  it('refuses an anonymous ask', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate({ ...askRequest, isAnonymous: true }, NOW),
      ),
    ).toBe('funding_ask_not_anonymous');
  });

  it.each([
    ['an IBAN in the title', { title: 'IBAN PT50 0002 0123 1234 5678 9015 4' }],
    [
      'a spaced IBAN in the body',
      { body: 'Or transfer: PT50 0002 0123 1234 5678 9015 4' },
    ],
    ['a solid PT mobile in the body', { body: 'MB Way +351912345678' }],
    ['a dashed PT mobile in the title', { title: 'Ligar 912-345-678' }],
  ])('refuses %s', (_label, override) => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate({ ...askRequest, ...override }, NOW),
      ),
    ).toBe('funding_payment_details_in_body');
  });

  it('refuses a lookalike crowdfunding host', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            ...askRequest,
            funding: {
              ...askRequest.funding,
              linkUrl: 'https://gofundme.com.evil.io/f/help-ana',
            },
          },
          NOW,
        ),
      ),
    ).toBe('funding_link_host_not_allowed');
  });

  it('keeps the payment check off open calls', () => {
    const { service } = buildService();
    expect(
      codeOf(() =>
        service.resolveForCreate(
          {
            kind: 'call',
            category: 'funding',
            title: 'Arts grant',
            body: 'Questions to the funder on 912 345 678',
            isAnonymous: false,
            funding: callInput,
          },
          NOW,
        ),
      ),
    ).toBeUndefined();
  });
});

describe('ForumFundingService.assertCanPostAsk', () => {
  it.each([VerificationLevel.None, VerificationLevel.Email])(
    'refuses a poster at %s level with 403',
    async (level) => {
      const { service, verification } = buildService();
      verification.levelForUser.mockResolvedValue(level);

      const attempt = service.assertCanPostAsk('author-1');

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      expect(await asyncCodeOf(service.assertCanPostAsk('author-1'))).toBe(
        'funding_ask_verification_required',
      );
    },
  );

  it.each([VerificationLevel.Phone, VerificationLevel.IdVerified])(
    'lets a poster at %s level through',
    async (level) => {
      const { service, verification } = buildService();
      verification.levelForUser.mockResolvedValue(level);

      await expect(
        service.assertCanPostAsk('author-1'),
      ).resolves.toBeUndefined();
      expect(verification.levelForUser).toHaveBeenCalledWith('author-1');
    },
  );
});

describe('ForumFundingService.assertAskLimit', () => {
  it('takes the per-member lock before counting live and pending asks', async () => {
    const { service, manager } = buildService();
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_count: 0 }]);

    await service.assertAskLimit(manager as never, 'author-1', 'thread-9', NOW);

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['funding-ask:author-1'],
    );
    const [countSql, countParameters] = manager.query.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(countSql).toContain(`"t"."review_state" = 'pending'`);
    expect(countSql).toContain('"funding"."ended_at" IS NULL');
    expect(countSql).toContain('"t"."id" <> $2');
    expect(countParameters).toEqual([
      'author-1',
      'thread-9',
      NOW,
      new Date(NOW.getTime() - ASK_AUTO_END_MS),
    ]);
  });

  it('counts an approved ask with no approval date as running, with the same boundaries deriveAskState uses', async () => {
    const { service, manager } = buildService();
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_count: 0 }]);

    await service.assertAskLimit(manager as never, 'author-1', 'thread-9', NOW);

    const [countSql] = manager.query.mock.calls[1] as [string, unknown[]];
    const flattenedSql = countSql.replace(/\s+/g, ' ');
    expect(flattenedSql).toContain(
      '"funding"."ends_at" IS NULL AND ( "funding"."approved_at" IS NULL OR "funding"."approved_at" >= $4 )',
    );
    // `deriveAskState` ends an ask only once `ends_at` is strictly past.
    expect(flattenedSql).toContain('"funding"."ends_at" >= $3');
    // Only pending and approved asks are counted; a rejected one never blocks
    // a corrected resubmission.
    expect(flattenedSql).not.toContain('rejected');
  });

  it('refuses a second live or pending ask with 409', async () => {
    const { service, manager } = buildService();
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_count: 1 }]);

    expect(
      await asyncCodeOf(
        service.assertAskLimit(manager as never, 'author-1', 'thread-9', NOW),
      ),
    ).toBe('funding_ask_limit_reached');
  });
});

describe('ForumFundingService review cycle', () => {
  it('sends an approved ask back to review on an author edit and clears its approval', async () => {
    const { service, manager } = buildService();
    const thread = approvedAsk();

    expect(
      await service.sendBackToReview(manager as never, thread, false),
    ).toBe(true);

    expect(thread.reviewState).toBe('pending');
    expect(manager.update).toHaveBeenCalledWith(
      ForumThread,
      { id: 'thread-1' },
      { reviewState: 'pending' },
    );
    expect(manager.update).toHaveBeenCalledWith(
      ForumThreadFunding,
      { threadId: 'thread-1' },
      { approvedAt: null },
    );
  });

  it('keeps an approved ask live when a moderator edits it', async () => {
    const { service, manager } = buildService();
    const thread = approvedAsk();

    expect(await service.sendBackToReview(manager as never, thread, true)).toBe(
      false,
    );
    expect(thread.reviewState).toBe('approved');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it.each(['pending', 'rejected'])(
    'leaves a %s ask as it is',
    async (reviewState) => {
      const { service, manager } = buildService();
      const thread = { ...approvedAsk(), reviewState } as ForumThread;

      expect(
        await service.sendBackToReview(manager as never, thread, false),
      ).toBe(false);
      expect(manager.update).not.toHaveBeenCalled();
    },
  );

  it('leaves open calls alone', async () => {
    const { service, manager } = buildService();

    expect(
      await service.sendBackToReview(
        manager as never,
        { ...callThread, reviewState: 'approved' },
        false,
      ),
    ).toBe(false);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('checks an opening-post edit of an ask for payment details before anything is written', async () => {
    const { service, manager } = buildService();
    manager.findOne.mockResolvedValue(approvedAsk());

    expect(
      await asyncCodeOf(
        service.onOpBodyEdit(
          manager as never,
          'thread-1',
          'IBAN: PT50 0002 0123 1234 5678 9015 4',
          false,
        ),
      ),
    ).toBe('funding_payment_details_in_body');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('sends an ask back to review on a clean opening-post edit', async () => {
    const { service, manager } = buildService();
    manager.findOne.mockResolvedValue(approvedAsk());

    await service.onOpBodyEdit(
      manager as never,
      'thread-1',
      'Updated: the clinic confirmed the date.',
      false,
    );

    expect(manager.findOne).toHaveBeenCalledWith(ForumThread, {
      where: { id: 'thread-1' },
    });
    expect(manager.update).toHaveBeenCalledWith(
      ForumThread,
      { id: 'thread-1' },
      { reviewState: 'pending' },
    );
  });

  it('leaves every other thread alone on an opening-post edit', async () => {
    const { service, manager } = buildService();
    manager.findOne.mockResolvedValue({
      ...callThread,
      reviewState: null,
    });

    await service.onOpBodyEdit(
      manager as never,
      'thread-1',
      'Questions to the funder on 912 345 678',
      false,
    );

    expect(manager.update).not.toHaveBeenCalled();
  });

  it('stamps the approval date on the approving transaction', async () => {
    const { service, fundingRows, manager } = buildService();

    await service.markAskApproved(manager as never, 'thread-1', NOW);

    expect(manager.update).toHaveBeenCalledWith(
      ForumThreadFunding,
      { threadId: 'thread-1' },
      { approvedAt: NOW },
    );
    // Nothing outside the transaction, so the approval and its date commit
    // together.
    expect(fundingRows.update).not.toHaveBeenCalled();
  });
});

describe('ForumFundingService.endAsk', () => {
  it('lets the author end their own ask with a reason', async () => {
    const { service, fundingRows } = buildService();
    fundingRows.findOne
      .mockResolvedValueOnce(askRow())
      .mockResolvedValueOnce(
        askRow({ endedAt: NOW, endedReason: 'goal_reached', updatedAt: NOW }),
      );

    const row = await service.endAsk(
      approvedAsk(),
      'author-1',
      'goal_reached',
      NOW,
    );

    // Conditional on the row still being open, so a racing end cannot
    // overwrite a reason another request already stored.
    expect(fundingRows.update).toHaveBeenCalledWith(
      { threadId: 'thread-1', endedAt: IsNull() },
      { endedAt: NOW, endedReason: 'goal_reached', updatedAt: NOW },
    );
    expect(fundingRows.save).not.toHaveBeenCalled();
    expect(fundingRows.findOne).toHaveBeenCalledTimes(2);
    expect(row).toEqual(
      expect.objectContaining({
        endedAt: NOW,
        endedReason: 'goal_reached',
        updatedAt: NOW,
      }),
    );
  });

  it('echoes the ending a concurrent request stored first', async () => {
    const { service, fundingRows } = buildService();
    const firstEnding = new Date('2026-10-05T08:59:59.000Z');
    fundingRows.findOne
      .mockResolvedValueOnce(askRow())
      .mockResolvedValueOnce(
        askRow({ endedAt: firstEnding, endedReason: 'closed' }),
      );
    // The other request's UPDATE committed between our read and our write,
    // so our conditional write matches no row.
    fundingRows.update.mockResolvedValueOnce({ affected: 0 });

    const row = await service.endAsk(
      approvedAsk(),
      'author-1',
      'goal_reached',
      NOW,
    );

    expect(row.endedAt).toEqual(firstEnding);
    expect(row.endedReason).toBe('closed');
  });

  it('refuses anyone but the author', async () => {
    const { service } = buildService();
    await expect(
      service.endAsk(approvedAsk(), 'someone-else', 'closed', NOW),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 for a thread that is not a fundraiser', async () => {
    const { service } = buildService();
    await expect(
      service.endAsk(callThread, 'author-1', 'closed', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the first ending when asked again', async () => {
    const { service, fundingRows } = buildService();
    const firstEnding = new Date('2026-10-01T09:00:00.000Z');
    fundingRows.findOne.mockResolvedValue(
      askRow({ endedAt: firstEnding, endedReason: 'closed' }),
    );

    const row = await service.endAsk(
      approvedAsk(),
      'author-1',
      'goal_reached',
      NOW,
    );

    expect(row.endedAt).toEqual(firstEnding);
    expect(row.endedReason).toBe('closed');
    expect(fundingRows.save).not.toHaveBeenCalled();
    expect(fundingRows.update).not.toHaveBeenCalled();
  });
});

describe('ForumFundingService.reviewFactsFor', () => {
  it('gives each ask its link host, poster level and account age', async () => {
    const { service, fundingRows, verification, users } = buildService();
    fundingRows.find.mockResolvedValue([askRow()]);
    verification.levelsForUsers.mockResolvedValue(
      new Map([['author-1', VerificationLevel.Phone]]),
    );
    users.find.mockResolvedValue([
      {
        id: 'author-1',
        createdAt: new Date(NOW.getTime() - 40 * DAY_MS - 1000),
      },
    ]);

    const facts = await service.reviewFactsFor(
      [approvedAsk(), { ...callThread, id: 'thread-2' }],
      NOW,
    );

    expect(facts).toEqual(
      new Map([
        [
          'thread-1',
          {
            linkHost: 'gofundme.com',
            posterVerificationLevel: VerificationLevel.Phone,
            posterAccountAgeDays: 40,
          },
        ],
      ]),
    );
    expect(verification.levelsForUsers).toHaveBeenCalledWith(['author-1']);
  });

  // The card's host reader, which stays lenient about a row written under
  // older link rules, so the reviewer and the donor see the same host.
  it('names the host the card shows even for a link the write rules would refuse today', async () => {
    const { service, fundingRows, verification, users } = buildService();
    fundingRows.find.mockResolvedValue([
      askRow({ linkUrl: 'http://WWW.GoFundMe.com/f/help-ana' }),
    ]);
    verification.levelsForUsers.mockResolvedValue(
      new Map([['author-1', VerificationLevel.Phone]]),
    );
    users.find.mockResolvedValue([
      { id: 'author-1', createdAt: new Date(NOW.getTime() - DAY_MS) },
    ]);

    const facts = await service.reviewFactsFor([approvedAsk()], NOW);

    expect(facts.get('thread-1')?.linkHost).toBe('gofundme.com');
  });

  it('reads nothing for a page without asks', async () => {
    const { service, verification, users } = buildService();

    expect(await service.reviewFactsFor([callThread], NOW)).toEqual(new Map());
    expect(verification.levelsForUsers).not.toHaveBeenCalled();
    expect(users.find).not.toHaveBeenCalled();
  });
});
