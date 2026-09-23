import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';

const CONVERSATION_ID = 'conversation-1';
const MEMBER_IDENTITY_ID = 'identity-member';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const SECOND_MAILBOX_IDENTITY_ID = 'identity-mailbox-2';

const NOT_A_PARTICIPANT_MESSAGE = 'You are not a participant';
const CLAIMED_AT = new Date('2026-03-01T09:00:00.000Z');

/** A profile row for `userId`, with a display name that names them. */
function profileOf(userId: string) {
  return {
    userId,
    slug: `${userId}-handle`,
    firstName: userId,
    lastName: 'Staff',
    pronouns: null,
    photoVisible: false,
    avatarUrl: null,
  };
}

/**
 * Awaits `promise` and returns the error it rejected with, typed as a plain
 * `Error` regardless of what the promise resolves to on its happy path.
 * Fails the test outright if the promise resolves instead of rejecting, so a
 * broken assertion cannot silently pass by comparing two `undefined`s.
 */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject, but it resolved');
}

/**
 * Builds a `ConversationsService` with every dependency `claim`/`release`
 * touch mocked out: `core` (`requireParticipant`, the participation gate
 * every read/write in this service runs first), `conversations` (the
 * conditional UPDATE and the re-read), `participants` (the seats
 * `resolveMailboxIdentityId` reads to find the mailbox), and `identities`
 * (`assertMayActAs`, standing in for `IdentitiesService`). The default shape
 * is a caller who is a participant and a business mailbox with two seats: a
 * customer's own profile identity and one shared mailbox identity, matching
 * how a real thread is seated (one `ConversationParticipant` row per staff
 * member, all carrying the mailbox's identity).
 */
function makeService(
  options: {
    affectedRows?: number;
    currentClaimant?: string | null;
    isParticipant?: boolean;
    isAllowedToActAs?: boolean;
    hasMailboxIdentity?: boolean;
    hasDuplicateMailboxIdentities?: boolean;
    hasConversation?: boolean;
  } = {},
) {
  const {
    affectedRows = 1,
    currentClaimant = null,
    isParticipant = true,
    isAllowedToActAs = true,
    hasMailboxIdentity = true,
    hasDuplicateMailboxIdentities = false,
    hasConversation = true,
  } = options;

  const service = Object.create(
    ConversationsService.prototype,
  ) as ConversationsService;

  const core = {
    requireParticipant: jest.fn().mockImplementation(async () => {
      if (!isParticipant) {
        throw new ForbiddenException(NOT_A_PARTICIPANT_MESSAGE);
      }
      return { conversationId: CONVERSATION_ID, userId: 'whoever-called' };
    }),
  };

  const builder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      affected: affectedRows,
      raw:
        affectedRows === 1
          ? [{ claimed_at: CLAIMED_AT, claim_released_at: CLAIMED_AT }]
          : [],
    }),
  };

  const conversationRow = hasConversation
    ? {
        id: CONVERSATION_ID,
        claimedByUserId: currentClaimant,
        claimedAt: currentClaimant ? CLAIMED_AT : null,
      }
    : null;

  const conversations = {
    createQueryBuilder: jest.fn(() => builder),
    findOne: jest.fn().mockResolvedValue(conversationRow),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  // Task 19: the claim responses name people through their profiles.
  const profiles = {
    find: jest.fn(({ where }: { where: { userId: { value: string[] } } }) =>
      Promise.resolve(
        where.userId.value.map((profileUserId) => profileOf(profileUserId)),
      ),
    ),
  };
  const eventEmitter = { emit: jest.fn() };

  const seats = [
    { identityId: MEMBER_IDENTITY_ID },
    ...(hasMailboxIdentity ? [{ identityId: MAILBOX_IDENTITY_ID }] : []),
    ...(hasDuplicateMailboxIdentities
      ? [{ identityId: SECOND_MAILBOX_IDENTITY_ID }]
      : []),
  ];
  const participants = {
    find: jest.fn().mockResolvedValue(seats),
  };

  const identities = {
    getById: jest.fn(async (identityId: string) => {
      if (
        identityId === MAILBOX_IDENTITY_ID ||
        identityId === SECOND_MAILBOX_IDENTITY_ID
      ) {
        return { id: identityId, kind: IdentityKind.Company };
      }
      return { id: MEMBER_IDENTITY_ID, kind: IdentityKind.Profile };
    }),
    assertMayActAs: jest.fn().mockImplementation(async () => {
      if (!isAllowedToActAs) {
        throw new ForbiddenException({
          code: 'IDENTITY_NOT_STAFF',
          message: 'You cannot send as this identity',
        });
      }
    }),
  };

  Object.assign(service, {
    core,
    conversations,
    participants,
    identities,
    profiles,
    eventEmitter,
  });
  return {
    service,
    core,
    builder,
    conversations,
    participants,
    identities,
    profiles,
    eventEmitter,
  };
}

describe('ConversationsService.claim', () => {
  it('claims an unclaimed thread', async () => {
    const { service } = makeService({ affectedRows: 1, currentClaimant: null });
    await expect(service.claim(CONVERSATION_ID, 'rui')).resolves.toEqual({
      claimedByUserId: 'rui',
      isNewlyClaimed: true,
      claimedBy: expect.objectContaining({ handle: 'rui-handle' }),
      claimedAt: CLAIMED_AT.toISOString(),
    });
  });

  it('loses the race and reports the winner', async () => {
    const { service, conversations } = makeService({
      affectedRows: 0,
      currentClaimant: 'ana',
    });
    await expect(service.claim(CONVERSATION_ID, 'rui')).resolves.toEqual({
      claimedByUserId: 'ana',
      isNewlyClaimed: false,
      claimedBy: expect.objectContaining({ handle: 'ana-handle' }),
      claimedAt: CLAIMED_AT.toISOString(),
    });
    // The loser path re-reads the row from the database to name the real
    // winner.
    expect(conversations.findOne).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
    });
  });

  it('claims conditionally in SQL so two callers cannot both win', async () => {
    const { service, builder } = makeService({
      affectedRows: 1,
      currentClaimant: null,
    });
    await service.claim(CONVERSATION_ID, 'rui');
    const guard = builder.andWhere.mock.calls.flat().join(' ');
    expect(guard).toContain('claimed_by_user_id IS NULL');
  });

  it('refuses a caller with no seat in the mailbox, before ever writing', async () => {
    const { service, builder } = makeService({ isAllowedToActAs: false });
    await expect(service.claim(CONVERSATION_ID, 'stranger')).rejects.toThrow(
      ForbiddenException,
    );
    expect(builder.execute).not.toHaveBeenCalled();
  });

  it('refuses to claim an ordinary member-to-member thread with no mailbox identity', async () => {
    const { service, builder } = makeService({ hasMailboxIdentity: false });
    await expect(service.claim(CONVERSATION_ID, 'rui')).rejects.toThrow(
      'Only a shared business mailbox thread can be claimed',
    );
    expect(builder.execute).not.toHaveBeenCalled();
  });

  it('refuses a non-participant identically whether the conversation exists or not', async () => {
    const onExisting = makeService({
      isParticipant: false,
      hasConversation: true,
    });
    const onMissing = makeService({
      isParticipant: false,
      hasConversation: false,
    });

    const existingError = await captureRejection(
      onExisting.service.claim(CONVERSATION_ID, 'stranger'),
    );
    const missingError = await captureRejection(
      onMissing.service.claim(CONVERSATION_ID, 'stranger'),
    );

    expect(existingError).toBeInstanceOf(ForbiddenException);
    expect(missingError).toBeInstanceOf(ForbiddenException);
    expect(existingError.message).toBe(missingError.message);
    expect(existingError.message).toBe(NOT_A_PARTICIPANT_MESSAGE);
    // Neither case ever reaches the mailbox lookup: a non-participant learns
    // nothing about whether this id is a real conversation.
    expect(onExisting.participants.find).not.toHaveBeenCalled();
    expect(onMissing.participants.find).not.toHaveBeenCalled();
  });

  it('throws when a conversation somehow carries two distinct mailbox identities', async () => {
    const { service } = makeService({ hasDuplicateMailboxIdentities: true });
    await expect(service.claim(CONVERSATION_ID, 'rui')).rejects.toThrow(
      'more than one business mailbox identity',
    );
  });
});

describe('ConversationsService.release', () => {
  it('lets the claimant release their own claim', async () => {
    const { service, builder } = makeService({ currentClaimant: 'rui' });
    await expect(service.release(CONVERSATION_ID, 'rui')).resolves.toEqual(
      expect.objectContaining({ isReleased: true, claimedByUserId: null }),
    );
    expect(builder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedByUserId: null,
        claimedAt: null,
        claimReleasedByUserId: 'rui',
      }),
    );
  });

  it("lets any staff member of the mailbox release a colleague's claim, and records it", async () => {
    const { service, builder } = makeService({ currentClaimant: 'ana' });
    await expect(
      service.release(CONVERSATION_ID, 'other-staff'),
    ).resolves.toEqual(expect.objectContaining({ claimedByUserId: null }));
    expect(builder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedByUserId: null,
        claimedAt: null,
        claimReleasedByUserId: 'other-staff',
      }),
    );
  });

  it('is a no-op on an already-unclaimed thread for any staff member with a seat', async () => {
    const { service, builder, conversations } = makeService({
      currentClaimant: null,
    });
    await expect(
      service.release(CONVERSATION_ID, 'other-staff'),
    ).resolves.toEqual(expect.objectContaining({ claimedByUserId: null }));
    expect(builder.execute).not.toHaveBeenCalled();
    expect(conversations.update).not.toHaveBeenCalled();
  });

  it('refuses release for a caller with no standing to act as the mailbox, and writes nothing', async () => {
    const { service, builder, conversations } = makeService({
      currentClaimant: 'ana',
      isAllowedToActAs: false,
    });
    await expect(service.release(CONVERSATION_ID, 'stranger')).rejects.toThrow(
      ForbiddenException,
    );
    expect(builder.execute).not.toHaveBeenCalled();
    expect(conversations.update).not.toHaveBeenCalled();
  });

  it('refuses a non-participant identically whether the conversation exists or not', async () => {
    const onExisting = makeService({
      isParticipant: false,
      hasConversation: true,
    });
    const onMissing = makeService({
      isParticipant: false,
      hasConversation: false,
    });

    const existingError = await captureRejection(
      onExisting.service.release(CONVERSATION_ID, 'stranger'),
    );
    const missingError = await captureRejection(
      onMissing.service.release(CONVERSATION_ID, 'stranger'),
    );

    expect(existingError).toBeInstanceOf(ForbiddenException);
    expect(missingError).toBeInstanceOf(ForbiddenException);
    expect(existingError.message).toBe(missingError.message);
    expect(existingError.message).toBe(NOT_A_PARTICIPANT_MESSAGE);
    expect(onExisting.conversations.update).not.toHaveBeenCalled();
    expect(onMissing.conversations.update).not.toHaveBeenCalled();
    expect(onExisting.builder.execute).not.toHaveBeenCalled();
    expect(onMissing.builder.execute).not.toHaveBeenCalled();
  });
});

describe('Task 19: take-over is gated like claim', () => {
  it('refuses a caller with no standing to act as the mailbox, before ever writing', async () => {
    const { service, builder } = makeService({ isAllowedToActAs: false });
    await expect(
      service.takeOver(CONVERSATION_ID, 'stranger', 'ana'),
    ).rejects.toThrow(ForbiddenException);
    expect(builder.execute).not.toHaveBeenCalled();
  });

  it('refuses an ordinary member-to-member thread with CONVERSATION_NOT_A_MAILBOX', async () => {
    const { service, builder } = makeService({ hasMailboxIdentity: false });
    const error = await captureRejection(
      service.takeOver(CONVERSATION_ID, 'rui', 'ana'),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({ code: 'CONVERSATION_NOT_A_MAILBOX' }),
    );
    expect(builder.execute).not.toHaveBeenCalled();
  });

  it('refuses a non-participant with the plain refusal, before the mailbox lookup', async () => {
    const { service, participants, builder } = makeService({
      isParticipant: false,
    });
    const error = await captureRejection(
      service.takeOver(CONVERSATION_ID, 'stranger', 'ana'),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toBe(NOT_A_PARTICIPANT_MESSAGE);
    expect(participants.find).not.toHaveBeenCalled();
    expect(builder.execute).not.toHaveBeenCalled();
  });
});
