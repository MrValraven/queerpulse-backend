import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { GroupsService } from './groups.service';
import { MessagingCoreService } from './messaging-core.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';

// M1 (storage-key impersonation): the group photo is a shared-upload surface
// (any owner/admin of the group edits the same conversation), so the
// interceptor exempts it and `updateGroup` draws the line via
// `assertNoForeignUploadIntroduced` — a foreign photo key is allowed only when
// it is already the stored value (an admin's no-op re-save); pointing the field
// at a NEW foreign upload is refused.
describe('GroupsService.updateGroup foreign photo ownership (M1)', () => {
  const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
  const OTHER_ID = '22222222-2222-2222-2222-222222222222';
  const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
  // A well-formed key whose embedded owner segment is NOT the actor.
  const FOREIGN_PHOTO = `group-avatars/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

  let service: GroupsService;
  let conversations: { findOne: jest.Mock; save: jest.Mock };
  let participants: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let core: {
    requireParticipant: jest.Mock;
    lastMessagesByConversation: jest.Mock;
    unreadCountsByConversation: jest.Mock;
    buildMemberSummaries: jest.Mock;
    reactionSummariesByMessage: jest.Mock;
    buildLastMessagePreview: jest.Mock;
    groupCapabilities: jest.Mock;
  };
  let mediaCropService: { getMany: jest.Mock };

  const makeGroup = (avatarUrl: string | null): Conversation =>
    ({
      id: 'c1',
      kind: ConversationKind.Group,
      title: 'Book club',
      avatarUrl,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as Conversation;

  beforeEach(() => {
    conversations = {
      findOne: jest.fn(),
      save: jest.fn((convo: unknown) => Promise.resolve(convo)),
    };
    participants = {
      find: jest
        .fn()
        .mockResolvedValue([{ userId: ACTOR_ID, clearedAt: null }]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      // An admin of the group (meets the Admin role gate).
      requireParticipant: jest
        .fn()
        .mockResolvedValue({ role: ConversationRole.Admin, leftAt: null }),
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      buildMemberSummaries: jest.fn().mockReturnValue([]),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      buildLastMessagePreview: jest.fn().mockReturnValue(null),
      groupCapabilities: jest.fn().mockReturnValue({}),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };

    service = new GroupsService(
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      {} as unknown as Repository<Message>,
      profiles as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mediaCropService as never,
    );
    // The group mapper resolves the photo through `toImageUrl`, which throws
    // `Service temporarily unavailable` when the base was never wired — and
    // every fixture here carries a storage key.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('lets an admin re-save the unchanged foreign photo already stored', async () => {
    conversations.findOne.mockResolvedValue(makeGroup(FOREIGN_PHOTO));
    await expect(
      service.updateGroup('c1', ACTOR_ID, { avatarUrl: FOREIGN_PHOTO }),
    ).resolves.toBeDefined();
    // Unchanged: no write, no impersonation.
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('rejects an admin introducing a new foreign photo key', async () => {
    conversations.findOne.mockResolvedValue(makeGroup(null));
    await expect(
      service.updateGroup('c1', ACTOR_ID, { avatarUrl: FOREIGN_PHOTO }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(conversations.save).not.toHaveBeenCalled();
  });
});
