import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import {
  CONVERSATION_CLAIM_CHANGED,
  ConversationClaimChangedEvent,
} from './conversation-claim';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Message, MessageKind } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { MessagingCoreService } from './messaging-core.service';
import { MESSAGE_CREATED } from './messaging.events';

/**
 * Task 23, part A (spec 4.3): a staff reply sent as the business claims an
 * unclaimed thread for its sender, in the same transaction as the insert.
 *
 * The transaction below is a small in-memory stand-in: writes made through
 * its manager are staged and reach `thread` only when the work resolves, so
 * a rejected transaction leaves no claim behind, as Postgres would. The
 * claim UPDATE honours its `claimed_by_user_id IS NULL` guard only when the
 * code actually adds it.
 */
const CONVERSATION_ID = 'c-mailbox';
const ANA = 'staff-ana';
const RUI = 'staff-rui';
const CUSTOMER = 'customer-marta';
const LISTING_IDENTITY_ID = 'identity-cafe-lisboa';
const ANA_PROFILE_IDENTITY_ID = 'identity-ana';
const CUSTOMER_PROFILE_IDENTITY_ID = 'identity-marta';
const CLAIMED_AT = new Date('2026-09-22T10:00:00.000Z');

const IDENTITY_KINDS = new Map<string, IdentityKind>([
  [LISTING_IDENTITY_ID, IdentityKind.Listing],
  [ANA_PROFILE_IDENTITY_ID, IdentityKind.Profile],
  [CUSTOMER_PROFILE_IDENTITY_ID, IdentityKind.Profile],
]);
const PROFILE_IDENTITY_BY_USER = new Map([
  [ANA, ANA_PROFILE_IDENTITY_ID],
  [CUSTOMER, CUSTOMER_PROFILE_IDENTITY_ID],
]);

interface ClaimUpdate {
  values: Record<string, unknown>;
  whereParameters: Record<string, unknown>;
  guards: string[];
}

function build(
  options: {
    claimedByUserId?: string | null;
    existingMessage?: Partial<Message> | null;
    insertError?: Error;
  } = {},
) {
  const thread = { claimedByUserId: options.claimedByUserId ?? null };
  const timeline: string[] = [];
  const claimUpdates: ClaimUpdate[] = [];

  const saveRow = (entity: Record<string, unknown>) =>
    Promise.resolve({
      id: 'saved-message',
      createdAt: new Date('2026-09-22T10:00:00.000Z'),
      editedAt: null,
      deletedAt: null,
      systemEvent: null,
      ...entity,
    });
  const messages = {
    findOne: jest.fn().mockResolvedValue(options.existingMessage ?? null),
    create: jest.fn((entity: Record<string, unknown>) => entity),
    save: jest.fn(saveRow),
  };
  const transactionMessageSave = jest.fn((entity: Record<string, unknown>) => {
    timeline.push('insert');
    return options.insertError
      ? Promise.reject(options.insertError)
      : saveRow(entity);
  });

  const claimQueryBuilder = (staged: { claimedByUserId?: string }) => {
    const update: ClaimUpdate = {
      values: {},
      whereParameters: {},
      guards: [],
    };
    const builder = {
      update: () => builder,
      set: (values: Record<string, unknown>) => {
        update.values = values;
        return builder;
      },
      where: (_condition: string, parameters: Record<string, unknown>) => {
        update.whereParameters = parameters;
        return builder;
      },
      andWhere: (condition: string) => {
        update.guards.push(condition);
        return builder;
      },
      returning: () => builder,
      execute: () => {
        timeline.push('claim');
        claimUpdates.push(update);
        const isGuarded = update.guards.includes('claimed_by_user_id IS NULL');
        if (isGuarded && thread.claimedByUserId !== null) {
          return Promise.resolve({ affected: 0, raw: [] });
        }
        staged.claimedByUserId = update.values.claimedByUserId as string;
        return Promise.resolve({
          affected: 1,
          raw: [{ claimed_at: CLAIMED_AT }],
        });
      },
    };
    return builder;
  };

  const transaction = jest.fn(
    async (
      work: (manager: {
        getRepository: (entity: unknown) => unknown;
      }) => Promise<unknown>,
    ) => {
      const staged: { claimedByUserId?: string } = {};
      const manager = {
        getRepository: (entity: unknown) => {
          if (entity === Message) {
            return { save: transactionMessageSave };
          }
          if (entity === Conversation) {
            return { createQueryBuilder: () => claimQueryBuilder(staged) };
          }
          throw new Error('unexpected repository in the transaction');
        },
      };
      const result = await work(manager);
      if (staged.claimedByUserId !== undefined) {
        thread.claimedByUserId = staged.claimedByUserId;
      }
      timeline.push('commit');
      return result;
    },
  );

  // Outside the transaction: only the archive reset `buildPostResult` runs.
  const archiveReset = {
    update: () => archiveReset,
    set: () => archiveReset,
    where: () => archiveReset,
    andWhere: () => archiveReset,
    execute: () => Promise.resolve({ affected: 0 }),
  };
  const participants = {
    exist: jest.fn().mockResolvedValue(true),
    createQueryBuilder: jest.fn(() => archiveReset),
  };
  const conversations = {
    createQueryBuilder: jest.fn(() => {
      throw new Error('a claim must go through the transaction manager');
    }),
  };
  const identities = {
    resolveProfileIdentityId: jest.fn((userId: string) =>
      Promise.resolve(PROFILE_IDENTITY_BY_USER.get(userId)),
    ),
    assertMayActAs: jest.fn().mockResolvedValue(undefined),
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        identityIds
          .filter((identityId) => IDENTITY_KINDS.has(identityId))
          .map((identityId) => ({
            id: identityId,
            kind: IDENTITY_KINDS.get(identityId),
          })),
      ),
    ),
  };
  const emitted: Array<[string, unknown]> = [];
  const eventEmitter = {
    emit: jest.fn((name: string, payload: unknown) => {
      timeline.push(name);
      emitted.push([name, payload]);
      return true;
    }),
  };
  const empty = {} as Record<string, never>;
  const service = new MessagingCoreService(
    conversations as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    messages as unknown as Repository<Message>,
    empty as unknown as Repository<MessageReaction>,
    empty as unknown as Repository<ConversationPinnedMessage>,
    empty as unknown as Repository<MessageStar>,
    empty as unknown as Repository<MessageHide>,
    empty as unknown as Repository<ContentModeration>,
    empty as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    { transaction } as unknown as DataSource,
    eventEmitter as unknown as EventEmitter2,
    empty as unknown as UsersService,
    identities as unknown as IdentitiesService,
    empty as unknown as IdentityAttributionService,
  );
  // The response shape is covered elsewhere; this suite reads the writes
  // and the events.
  jest
    .spyOn(service, 'toMessageResponses')
    .mockResolvedValue([{ id: 'saved-message' } as never]);

  const claimEvents = () =>
    emitted
      .filter(([name]) => name === CONVERSATION_CLAIM_CHANGED)
      .map(([, payload]) => payload as ConversationClaimChangedEvent);

  return {
    service,
    thread,
    timeline,
    claimUpdates,
    transaction,
    transactionMessageSave,
    messages,
    identities,
    claimEvents,
  };
}

function replyAs(
  service: MessagingCoreService,
  senderId: string,
  asIdentityId?: string,
) {
  return service.postMessage(
    CONVERSATION_ID,
    senderId,
    'We open at nine',
    undefined,
    'client-message-1',
    false,
    'user',
    undefined,
    undefined,
    asIdentityId,
  );
}

describe('MessagingCoreService.postMessage, a reply claims the thread (Task 23)', () => {
  it('claims an unclaimed thread for a staff reply sent as the business, in the same transaction as the insert', async () => {
    const harness = build();

    const result = await replyAs(harness.service, ANA, LISTING_IDENTITY_ID);

    expect(result.isNew).toBe(true);
    expect(harness.thread.claimedByUserId).toBe(ANA);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    // Both writes went through the transaction's manager.
    expect(harness.transactionMessageSave).toHaveBeenCalledTimes(1);
    expect(harness.messages.save).not.toHaveBeenCalled();
    expect(harness.timeline.slice(0, 3)).toEqual(['insert', 'claim', 'commit']);
    expect(harness.claimUpdates).toHaveLength(1);
    expect(harness.claimUpdates[0]!.values).toMatchObject({
      claimedByUserId: ANA,
      claimReleasedByUserId: null,
      claimReleasedAt: null,
      claimTakenOverFromUserId: null,
    });
    expect(harness.claimUpdates[0]!.whereParameters).toEqual({
      conversationId: CONVERSATION_ID,
    });
    expect(harness.claimUpdates[0]!.guards).toEqual([
      'claimed_by_user_id IS NULL',
    ]);
    // One batched identity read for the whole send.
    expect(harness.identities.getByIds).toHaveBeenCalledTimes(1);
    expect(harness.claimEvents()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        mailboxIdentityId: LISTING_IDENTITY_ID,
        change: 'claimed',
        isImplicit: true,
        actorUserId: ANA,
        claimedByUserId: ANA,
        previousClaimantUserId: null,
        changedAt: CLAIMED_AT,
      },
    ]);
  });

  it('leaves a colleague claim unchanged and announces nothing', async () => {
    const harness = build({ claimedByUserId: RUI });

    const result = await replyAs(harness.service, ANA, LISTING_IDENTITY_ID);

    expect(result.isNew).toBe(true);
    expect(harness.thread.claimedByUserId).toBe(RUI);
    expect(harness.claimEvents()).toEqual([]);
    expect(harness.timeline).toContain(MESSAGE_CREATED);
  });

  it('claims nothing for a customer send, a personal send or an idempotent replay', async () => {
    const customer = build();
    await replyAs(customer.service, CUSTOMER);
    expect(customer.transaction).not.toHaveBeenCalled();
    expect(customer.identities.getByIds).not.toHaveBeenCalled();
    expect(customer.thread.claimedByUserId).toBeNull();
    expect(customer.claimEvents()).toEqual([]);

    // A server-composed send that names the sender's own profile identity.
    const personal = build();
    await replyAs(personal.service, ANA, ANA_PROFILE_IDENTITY_ID);
    expect(personal.transaction).not.toHaveBeenCalled();
    expect(personal.messages.save).toHaveBeenCalledTimes(1);
    expect(personal.thread.claimedByUserId).toBeNull();
    expect(personal.claimEvents()).toEqual([]);

    const replay = build({
      existingMessage: {
        id: 'earlier-message',
        conversationId: CONVERSATION_ID,
        senderId: ANA,
        senderIdentityId: LISTING_IDENTITY_ID,
        body: 'We open at nine',
        replyToId: null,
        clientMessageId: 'client-message-1',
        forwarded: false,
        kind: MessageKind.User,
        systemEvent: null,
        attachment: null,
        createdAt: new Date('2026-09-22T09:59:00.000Z'),
        editedAt: null,
        deletedAt: null,
      },
    });
    const replayed = await replyAs(replay.service, ANA, LISTING_IDENTITY_ID);
    expect(replayed.isNew).toBe(false);
    expect(replay.transaction).not.toHaveBeenCalled();
    expect(replay.thread.claimedByUserId).toBeNull();
    expect(replay.claimEvents()).toEqual([]);
  });

  it('leaves the thread unclaimed when the insert inside the transaction throws', async () => {
    const harness = build({ insertError: new Error('insert failed') });

    await expect(
      replyAs(harness.service, ANA, LISTING_IDENTITY_ID),
    ).rejects.toThrow('insert failed');

    expect(harness.transactionMessageSave).toHaveBeenCalledTimes(1);
    expect(harness.thread.claimedByUserId).toBeNull();
    expect(harness.timeline).not.toContain('commit');
    expect(harness.claimEvents()).toEqual([]);
  });

  it('returns the winner of a lost idempotency race with the claim rolled back', async () => {
    const uniqueViolation = new QueryFailedError('INSERT', [], {
      code: '23505',
    } as unknown as Error);
    const harness = build({ insertError: uniqueViolation });
    const winner = {
      id: 'winner-message',
      conversationId: CONVERSATION_ID,
      senderId: ANA,
      senderIdentityId: LISTING_IDENTITY_ID,
      body: 'We open at nine',
      replyToId: null,
      clientMessageId: 'client-message-1',
      forwarded: false,
      kind: MessageKind.User,
      systemEvent: null,
      attachment: null,
      createdAt: new Date('2026-09-22T09:59:00.000Z'),
      editedAt: null,
      deletedAt: null,
    };
    harness.messages.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);

    const result = await replyAs(harness.service, ANA, LISTING_IDENTITY_ID);

    expect(result.isNew).toBe(false);
    expect(result.view.id).toBe('winner-message');
    expect(harness.transactionMessageSave).toHaveBeenCalledTimes(1);
    expect(harness.thread.claimedByUserId).toBeNull();
    expect(harness.claimEvents()).toEqual([]);
  });

  it('announces the claim after the commit and before MESSAGE_CREATED', async () => {
    const harness = build();

    await replyAs(harness.service, ANA, LISTING_IDENTITY_ID);

    const commitAt = harness.timeline.indexOf('commit');
    const claimEventAt = harness.timeline.indexOf(CONVERSATION_CLAIM_CHANGED);
    const messageCreatedAt = harness.timeline.indexOf(MESSAGE_CREATED);
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(claimEventAt).toBeGreaterThan(commitAt);
    expect(messageCreatedAt).toBeGreaterThan(claimEventAt);
  });
});
