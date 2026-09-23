import { ForbiddenException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 18: `MessagingCoreService.getOrCreateIdentityConversation`, the thread
 * a customer opens with a listing, persona or company mailbox. Driven through
 * the real method with only its storage and `IdentitiesService` stubbed.
 */

interface StubIdentity {
  id: string;
  kind: IdentityKind;
  userId?: string;
}

interface SavedRow {
  [column: string]: unknown;
}

function profileIdentityId(userId: string): string {
  return `profile-${userId}`;
}

function makeCore(options: {
  staffByIdentityId: Record<string, string[]>;
  mailboxKindByIdentityId?: Record<string, IdentityKind>;
  removedIdentityIds?: string[];
  existingConversations?: SavedRow[];
}) {
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  const savedConversations: SavedRow[] = [
    ...(options.existingConversations ?? []),
  ];
  const savedSeats: SavedRow[] = [];
  const identityOf = (identityId: string): StubIdentity | null => {
    if (identityId.startsWith('profile-')) {
      return {
        id: identityId,
        kind: IdentityKind.Profile,
        userId: identityId.slice('profile-'.length),
      };
    }
    const kind = options.mailboxKindByIdentityId?.[identityId];
    if (kind) {
      return { id: identityId, kind };
    }
    return options.staffByIdentityId[identityId]
      ? { id: identityId, kind: IdentityKind.Listing }
      : null;
  };
  const staffOf = (identityId: string): string[] => {
    const identity = identityOf(identityId);
    if (identity?.kind === IdentityKind.Profile) {
      return [identity.userId!];
    }
    return options.staffByIdentityId[identityId] ?? [];
  };
  const identities = {
    getById: jest.fn((identityId: string) =>
      Promise.resolve(identityOf(identityId)),
    ),
    resolveProfileIdentityId: jest.fn((userId: string) =>
      Promise.resolve(profileIdentityId(userId)),
    ),
    staffUserIds: jest.fn((identityId: string) =>
      Promise.resolve(staffOf(identityId)),
    ),
    isRemovedPersona: jest.fn((identity: StubIdentity) =>
      Promise.resolve((options.removedIdentityIds ?? []).includes(identity.id)),
    ),
    assertMayActAs: jest.fn((userId: string, identityId: string) => {
      if (!staffOf(identityId).includes(userId)) {
        return Promise.reject(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        );
      }
      return Promise.resolve();
    }),
  };
  const conversations = {
    findOne: jest.fn(({ where }: { where: { pairKey: string } }) =>
      Promise.resolve(
        savedConversations.find(
          (conversation) => conversation.pairKey === where.pairKey,
        ) ?? null,
      ),
    ),
    update: jest.fn(() => Promise.resolve()),
  };
  const transaction = jest.fn((run: (manager: unknown) => Promise<unknown>) =>
    run({
      create: (_entity: unknown, row: SavedRow) => ({ ...row }),
      save: (rows: SavedRow | SavedRow[]) => {
        if (Array.isArray(rows)) {
          savedSeats.push(...rows);
          return Promise.resolve(rows);
        }
        const conversation = {
          ...rows,
          id: `conversation-${savedConversations.length + 1}`,
        };
        savedConversations.push(conversation);
        return Promise.resolve(conversation);
      },
    }),
  );
  Object.assign(core, {
    identities,
    conversations,
    dataSource: { transaction },
  });
  return {
    core,
    identities,
    conversations,
    transaction,
    savedConversations,
    savedSeats,
  };
}

async function refusalCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return (response as { code?: string } | undefined)?.code;
  }
  throw new Error('expected a refusal');
}

describe('getOrCreateIdentityConversation', () => {
  it('seats the customer once and every staff member of the business, each stamped with the mailbox identity', async () => {
    const { core, savedSeats } = makeCore({
      staffByIdentityId: {
        'business-identity': ['owner-user', 'comanager-user'],
      },
    });

    const { created } = await core.getOrCreateIdentityConversation(
      'customer-user',
      'business-identity',
      'customer-user',
    );

    expect(created).toBe(true);
    expect(savedSeats).toHaveLength(3);
    expect(
      savedSeats
        .filter((seat) => seat.identityId === 'business-identity')
        .map((seat) => seat.userId),
    ).toEqual(['owner-user', 'comanager-user']);
    expect(
      savedSeats
        .filter((seat) => seat.identityId === 'profile-customer-user')
        .map((seat) => seat.userId),
    ).toEqual(['customer-user']);
  });

  it('keys the thread on the identity pair, so the personal thread with the owner stays separate', async () => {
    const { core, savedConversations } = makeCore({
      staffByIdentityId: { 'business-identity': ['owner-user'] },
    });

    await core.getOrCreateIdentityConversation(
      'customer-user',
      'business-identity',
      'customer-user',
    );

    expect(savedConversations[0]?.pairKey).toBe(
      ['profile-customer-user', 'business-identity'].sort().join(':'),
    );
    expect(savedConversations[0]?.pairKey).not.toContain('owner-user');
  });

  it('orders the pair key byte-wise, as COLLATE "C" does in the pair key migrations', async () => {
    // The customer's identity is `profile-x` and the mailbox's `profilex`.
    // A hyphen (0x2d) sorts before a letter byte-wise, while a
    // punctuation-blind locale comparison would not put it first.
    const { core, savedConversations } = makeCore({
      staffByIdentityId: { profilex: ['owner-user'] },
    });

    await core.getOrCreateIdentityConversation('x', 'profilex', 'x');

    expect(savedConversations[0]?.pairKey).toBe('profile-x:profilex');
  });

  it('seeds the cold-contact initiator on a new thread, so any staff member can answer with one tap', async () => {
    const { core, savedConversations } = makeCore({
      staffByIdentityId: { 'business-identity': ['owner-user'] },
    });

    await core.getOrCreateIdentityConversation(
      'customer-user',
      'business-identity',
      'customer-user',
    );

    expect(savedConversations[0]).toMatchObject({
      initiatorUserId: 'customer-user',
      isOfficial: false,
    });
  });

  it('refuses a mailbox with no staff, and opens nothing', async () => {
    const { core, transaction } = makeCore({
      staffByIdentityId: {},
      mailboxKindByIdentityId: { 'ownerless-identity': IdentityKind.Company },
    });

    await expect(
      refusalCode(
        core.getOrCreateIdentityConversation(
          'customer-user',
          'ownerless-identity',
          'customer-user',
        ),
      ),
    ).resolves.toBe('IDENTITY_HAS_NO_STAFF');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a staff member writing to their own mailbox', async () => {
    const { core, transaction } = makeCore({
      staffByIdentityId: {
        'business-identity': ['owner-user', 'comanager-user'],
      },
    });

    await expect(
      refusalCode(
        core.getOrCreateIdentityConversation(
          'comanager-user',
          'business-identity',
          'comanager-user',
        ),
      ),
    ).resolves.toBe('IDENTITY_IS_YOUR_OWN');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a persona moderation removed', async () => {
    const { core, transaction } = makeCore({
      staffByIdentityId: { 'persona-identity': ['persona-owner'] },
      mailboxKindByIdentityId: { 'persona-identity': IdentityKind.Subprofile },
      removedIdentityIds: ['persona-identity'],
    });

    await expect(
      refusalCode(
        core.getOrCreateIdentityConversation(
          'customer-user',
          'persona-identity',
          'customer-user',
        ),
      ),
    ).resolves.toBe('IDENTITY_REMOVED');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a profile identity as the target, which is no mailbox', async () => {
    const { core, transaction } = makeCore({ staffByIdentityId: {} });

    await expect(
      refusalCode(
        core.getOrCreateIdentityConversation(
          'customer-user',
          profileIdentityId('someone-else'),
          'customer-user',
        ),
      ),
    ).resolves.toBe('IDENTITY_NOT_A_MAILBOX');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a member acting as a business they staff, the reply-only rule', async () => {
    const { core, transaction } = makeCore({
      staffByIdentityId: {
        'their-listing-identity': ['staff-user'],
        'other-company-identity': ['company-owner'],
      },
    });

    await expect(
      refusalCode(
        core.getOrCreateIdentityConversation(
          'staff-user',
          'other-company-identity',
          'staff-user',
          'their-listing-identity',
        ),
      ),
    ).resolves.toBe('IDENTITY_CANNOT_INITIATE');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a member naming an identity they cannot act as', async () => {
    const { core, transaction } = makeCore({
      staffByIdentityId: {
        'someone-elses-listing': ['someone-else'],
        'business-identity': ['owner-user'],
      },
    });

    await expect(
      refusalCode(
        core.getOrCreateIdentityConversation(
          'customer-user',
          'business-identity',
          'customer-user',
          'someone-elses-listing',
        ),
      ),
    ).resolves.toBe('IDENTITY_NOT_STAFF');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('opens the thread when the named identity is the member’s own profile', async () => {
    const { core, savedSeats } = makeCore({
      staffByIdentityId: { 'business-identity': ['owner-user'] },
    });

    await core.getOrCreateIdentityConversation(
      'customer-user',
      'business-identity',
      'customer-user',
      profileIdentityId('customer-user'),
    );

    expect(savedSeats.map((seat) => seat.userId)).toEqual([
      'customer-user',
      'owner-user',
    ]);
  });

  describe('reuse', () => {
    const existingPairKey = ['profile-customer-user', 'business-identity']
      .sort()
      .join(':');

    it('returns the existing thread for the pair and creates nothing', async () => {
      const { core, transaction } = makeCore({
        staffByIdentityId: { 'business-identity': ['owner-user'] },
        existingConversations: [
          {
            id: 'existing-conversation',
            pairKey: existingPairKey,
            initiatorUserId: 'customer-user',
            openedAt: null,
          },
        ],
      });

      const result = await core.getOrCreateIdentityConversation(
        'customer-user',
        'business-identity',
        'customer-user',
      );

      expect(result.created).toBe(false);
      expect(result.conversation.id).toBe('existing-conversation');
      expect(transaction).not.toHaveBeenCalled();
    });

    it('claims the initiator on an unopened thread with none, as the personal path does', async () => {
      const { core, conversations } = makeCore({
        staffByIdentityId: { 'business-identity': ['owner-user'] },
        existingConversations: [
          {
            id: 'existing-conversation',
            pairKey: existingPairKey,
            initiatorUserId: null,
            openedAt: null,
          },
        ],
      });

      const { conversation } = await core.getOrCreateIdentityConversation(
        'customer-user',
        'business-identity',
        'customer-user',
      );

      expect(conversations.update).toHaveBeenCalledWith(
        'existing-conversation',
        { initiatorUserId: 'customer-user' },
      );
      expect(conversation.initiatorUserId).toBe('customer-user');
    });

    it('leaves an open thread’s initiator alone', async () => {
      const { core, conversations } = makeCore({
        staffByIdentityId: { 'business-identity': ['owner-user'] },
        existingConversations: [
          {
            id: 'existing-conversation',
            pairKey: existingPairKey,
            initiatorUserId: null,
            openedAt: new Date('2026-09-01T10:00:00Z'),
          },
        ],
      });

      await core.getOrCreateIdentityConversation(
        'customer-user',
        'business-identity',
        'customer-user',
      );

      expect(conversations.update).not.toHaveBeenCalled();
    });

    it('still refuses a reused thread when the member acts as a business', async () => {
      const { core } = makeCore({
        staffByIdentityId: {
          'business-identity': ['owner-user'],
          'their-listing-identity': ['customer-user'],
        },
        existingConversations: [
          {
            id: 'existing-conversation',
            pairKey: existingPairKey,
            initiatorUserId: 'customer-user',
            openedAt: null,
          },
        ],
      });

      await expect(
        refusalCode(
          core.getOrCreateIdentityConversation(
            'customer-user',
            'business-identity',
            'customer-user',
            'their-listing-identity',
          ),
        ),
      ).resolves.toBe('IDENTITY_CANNOT_INITIATE');
    });

    it('refuses reuse once the mailbox has no staff left', async () => {
      const { core } = makeCore({
        staffByIdentityId: {},
        mailboxKindByIdentityId: { 'business-identity': IdentityKind.Company },
        existingConversations: [
          {
            id: 'existing-conversation',
            pairKey: existingPairKey,
            initiatorUserId: 'customer-user',
            openedAt: null,
          },
        ],
      });

      await expect(
        refusalCode(
          core.getOrCreateIdentityConversation(
            'customer-user',
            'business-identity',
            'customer-user',
          ),
        ),
      ).resolves.toBe('IDENTITY_HAS_NO_STAFF');
    });
  });

  it('returns the winner when a concurrent create won the pair key race', async () => {
    const { core, conversations, transaction } = makeCore({
      staffByIdentityId: { 'business-identity': ['owner-user'] },
    });
    const winner = { id: 'winner-conversation' };
    conversations.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const uniqueViolation = new QueryFailedError('INSERT', [], {
      code: '23505',
    } as unknown as Error);
    transaction.mockRejectedValueOnce(uniqueViolation);

    const result = await core.getOrCreateIdentityConversation(
      'customer-user',
      'business-identity',
      'customer-user',
    );

    expect(result).toEqual({ conversation: winner, created: false });
  });

  it('rethrows any other failure untouched', async () => {
    const { core, transaction } = makeCore({
      staffByIdentityId: { 'business-identity': ['owner-user'] },
    });
    const failure = new Error('connection lost');
    transaction.mockRejectedValueOnce(failure);

    await expect(
      core.getOrCreateIdentityConversation(
        'customer-user',
        'business-identity',
        'customer-user',
      ),
    ).rejects.toBe(failure);
  });
});
