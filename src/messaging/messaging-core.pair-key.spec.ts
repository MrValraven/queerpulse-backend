import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Message } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { MessagingCoreService } from './messaging-core.service';

describe('MessagingCoreService.identityPairKey', () => {
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;

  it('sorts the pair so either argument order gives one key', () => {
    expect(core.identityPairKey('bbb', 'aaa')).toBe(
      core.identityPairKey('aaa', 'bbb'),
    );
  });

  it('gives a personal thread and a business thread different keys', () => {
    const customer = 'customer-identity';
    const ownerPersonal = 'owner-profile-identity';
    const business = 'listing-identity';
    expect(core.identityPairKey(customer, ownerPersonal)).not.toBe(
      core.identityPairKey(customer, business),
    );
  });

  it('rejects a self pair', () => {
    expect(() => core.identityPairKey('same', 'same')).toThrow();
  });
});

const USER_A = 'user-a';
const USER_B = 'user-b';

/** Each user's own profile identity, distinct per user so a test that
 *  transposes A's and B's identity fails rather than passing by accident. */
function profileIdentityOf(userId: string): string {
  return `profile-identity-of-${userId}`;
}

/**
 * Builds a `MessagingCoreService` with just enough of its repositories and
 * `IdentitiesService` mocked to exercise `getOrCreateConversation`, in the
 * style of `messaging-core.service.spec.ts`'s own `build()`. Every dependency
 * `getOrCreateConversation` never touches stays an untyped `empty` stand-in.
 */
function buildService(
  options: { existingConversation?: Conversation | null } = {},
) {
  const conversationsRepo = {
    findOne: jest.fn().mockResolvedValue(options.existingConversation ?? null),
    update: jest.fn(),
  };
  const createdParticipants: Record<string, unknown>[] = [];
  let createdConversation: Record<string, unknown> | null = null;
  // Stands in for the TypeORM transaction's `EntityManager`: `create` echoes
  // its input back (mirrors the existing sticker specs' repository mocks),
  // and `save` records a participant array into `createdParticipants` or a
  // lone conversation into `createdConversation`, whichever it is called
  // with, so a test can inspect exactly what `getOrCreateConversation` wrote.
  const manager = {
    create: jest.fn((_entityClass: unknown, data: Record<string, unknown>) => ({
      ...data,
    })),
    save: jest.fn((arg: unknown) => {
      if (Array.isArray(arg)) {
        createdParticipants.push(...(arg as Record<string, unknown>[]));
        return Promise.resolve(arg);
      }
      createdConversation = {
        id: 'convo-created-id',
        ...(arg as Record<string, unknown>),
      };
      return Promise.resolve(createdConversation);
    }),
  };
  const dataSource = {
    transaction: jest.fn((work: (manager: unknown) => unknown) =>
      work(manager),
    ),
  };
  const resolveProfileIdentityId = jest
    .fn()
    .mockImplementation((userId: string) =>
      Promise.resolve(profileIdentityOf(userId)),
    );
  // `getOrCreateConversation` now gates a fresh thread on
  // `assertInitiatorIsProfile`, which reads the initiator's identity back by
  // id; every identity this suite resolves is a profile identity, so the
  // stand-in always answers `IdentityKind.Profile`.
  const getById = jest
    .fn()
    .mockResolvedValue({ id: 'stub-identity', kind: IdentityKind.Profile });
  const identities = { resolveProfileIdentityId, getById };
  const empty = {} as Record<string, never>;
  const service = new MessagingCoreService(
    conversationsRepo as unknown as Repository<Conversation>,
    empty as unknown as Repository<ConversationParticipant>,
    empty as unknown as Repository<Message>,
    empty as unknown as Repository<MessageReaction>,
    empty as unknown as Repository<ConversationPinnedMessage>,
    empty as unknown as Repository<MessageStar>,
    empty as unknown as Repository<MessageHide>,
    empty as unknown as Repository<ContentModeration>,
    empty as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    dataSource as unknown as DataSource,
    empty as unknown as EventEmitter2,
    empty as unknown as UsersService,
    identities as unknown as IdentitiesService,
    // Task 11: unused by the pair-key path under test here.
    {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    } as unknown as IdentityAttributionService,
  );
  return {
    service,
    conversationsRepo,
    resolveProfileIdentityId,
    createdParticipants,
    getCreatedConversation: () => createdConversation,
    transaction: dataSource.transaction,
  };
}

describe('MessagingCoreService.getOrCreateConversation (identity resolution)', () => {
  it('resolves both sides to their own profile identity and stores the identity pair key when identityIdB is omitted', async () => {
    const { service, getCreatedConversation } = buildService();

    await service.getOrCreateConversation(USER_A, USER_B);

    expect(getCreatedConversation()?.pairKey).toBe(
      'profile-identity-of-user-a:profile-identity-of-user-b',
    );
  });

  it('stamps each created participant row with the identity belonging to ITS OWN user, never the other side', async () => {
    const { service, createdParticipants } = buildService();

    await service.getOrCreateConversation(USER_A, USER_B);

    const participantA = createdParticipants.find((p) => p.userId === USER_A);
    const participantB = createdParticipants.find((p) => p.userId === USER_B);
    expect(participantA?.identityId).toBe(profileIdentityOf(USER_A));
    expect(participantB?.identityId).toBe(profileIdentityOf(USER_B));
  });

  it('uses an explicit identityIdB for side B while side A still resolves to its own profile identity', async () => {
    const explicitIdentityIdB = 'listing-identity-xyz';
    const {
      service,
      resolveProfileIdentityId,
      createdParticipants,
      getCreatedConversation,
    } = buildService();

    await service.getOrCreateConversation(
      USER_A,
      USER_B,
      undefined,
      explicitIdentityIdB,
    );

    expect(resolveProfileIdentityId).toHaveBeenCalledWith(USER_A);
    expect(resolveProfileIdentityId).not.toHaveBeenCalledWith(USER_B);
    const participantA = createdParticipants.find((p) => p.userId === USER_A);
    const participantB = createdParticipants.find((p) => p.userId === USER_B);
    expect(participantA?.identityId).toBe(profileIdentityOf(USER_A));
    expect(participantB?.identityId).toBe(explicitIdentityIdB);
    expect(getCreatedConversation()?.pairKey).toBe(
      'listing-identity-xyz:profile-identity-of-user-a',
    );
  });

  it('reuses an existing conversation for the computed pair key and creates nothing new', async () => {
    const existingConversation = {
      id: 'existing-convo-id',
      pairKey: 'profile-identity-of-user-a:profile-identity-of-user-b',
      initiatorUserId: null,
      openedAt: null,
    } as unknown as Conversation;
    const { service, transaction, createdParticipants } = buildService({
      existingConversation,
    });

    const result = await service.getOrCreateConversation(USER_A, USER_B);

    expect(result.conversation).toBe(existingConversation);
    expect(result.created).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(createdParticipants).toHaveLength(0);
  });
});
