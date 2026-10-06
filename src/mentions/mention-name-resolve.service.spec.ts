import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Listing } from '../listings/entities/listing.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { matchedChatMemberKey } from '../messaging/matched-member-key';
import { Profile } from '../users/entities/profile.entity';
import { MentionNameResolveService } from './mention-name-resolve.service';

/**
 * PRD-423: inside a matched Go together chat, a mention of one of its members
 * resolves to that member's first name, the spelling every other name in the
 * chat uses. Anywhere else, and for anyone outside the chat's seats, a
 * mention keeps the member's full name.
 */

const VIEWER_ID = 'viewer-1';
const ANA_ID = 'ana-1';
const OUTSIDER_ID = 'outsider-1';
const CONVERSATION_ID = '4f1c7a52-9a3e-4d4b-8f5e-2b6c1d0e9a11';

const PROFILES = [
  { userId: ANA_ID, slug: 'ana-sousa', firstName: 'Ana', lastName: 'Sousa' },
  {
    userId: OUTSIDER_ID,
    slug: 'rui-lopes',
    firstName: 'Rui',
    lastName: 'Lopes',
  },
] as Profile[];

function buildService(options: {
  eventMatchGroupId: string | null;
  isGoTogetherChat?: boolean;
  seatUserIds: string[];
}) {
  let profileQueryCount = 0;
  const profileQuery = {
    innerJoin: () => profileQuery,
    where: () => profileQuery,
    getMany: () => {
      profileQueryCount += 1;
      return Promise.resolve(PROFILES);
    },
  };
  const empty = { find: jest.fn().mockResolvedValue([]) };
  const conversations = {
    findOne: jest.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      eventMatchGroupId: options.eventMatchGroupId,
      isGoTogetherChat:
        options.isGoTogetherChat ?? options.eventMatchGroupId !== null,
    }),
  };
  const participants = {
    find: jest
      .fn()
      .mockResolvedValue(options.seatUserIds.map((userId) => ({ userId }))),
  };
  const service = new MentionNameResolveService(
    {
      createQueryBuilder: () => profileQuery,
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Community>,
    empty as unknown as Repository<CommunityMember>,
    empty as unknown as Repository<Listing>,
    empty as unknown as Repository<Event>,
    empty as unknown as Repository<ForumThread>,
    conversations as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
  );
  return { service, conversations, profileQueries: () => profileQueryCount };
}

const REFS = ['member:ana-sousa', 'member:rui-lopes'];

function nameBySlug(resolved: { slug: string; name: string }[]) {
  return Object.fromEntries(resolved.map((entry) => [entry.slug, entry.name]));
}

describe('MentionNameResolveService, matched Go together chats (PRD-423)', () => {
  it('resolves no slug member mention for a viewer seated in a matched chat, seated member or not', async () => {
    const { service, profileQueries } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    // The chat answers nothing about a slug: no lookup runs at all.
    expect(nameBySlug(resolved)).toEqual({});
    expect(profileQueries()).toBe(0);
  });

  it('names a member by key in a Go together chat whose group row is gone', async () => {
    const anaKey = matchedChatMemberKey(CONVERSATION_ID, ANA_ID);
    const { service } = buildService({
      eventMatchGroupId: null,
      isGoTogetherChat: true,
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(
      VIEWER_ID,
      [`member:${anaKey}`, 'member:ana-sousa'],
      CONVERSATION_ID,
    );

    expect(nameBySlug(resolved)).toEqual({ [anaKey]: 'Ana' });
  });

  it('keeps full names in a normal group', async () => {
    const { service } = buildService({
      eventMatchGroupId: null,
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
  });

  it('keeps full names for a viewer who holds no seat in the matched chat', async () => {
    const { service } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
  });

  it('reads no conversation when the caller names none', async () => {
    const { service, conversations } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
    expect(conversations.findOne).not.toHaveBeenCalled();
  });

  describe('PRD-423 (opaque member keys)', () => {
    const anaKey = matchedChatMemberKey(CONVERSATION_ID, ANA_ID);

    it('names a member mentioned by their per-chat key, for a viewer seated in the chat', async () => {
      const { service } = buildService({
        eventMatchGroupId: 'match-group-1',
        seatUserIds: [VIEWER_ID, ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${anaKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[anaKey]).toBe('Ana');
    });

    it('leaves a key unresolved for a viewer who holds no seat', async () => {
      const { service } = buildService({
        eventMatchGroupId: 'match-group-1',
        seatUserIds: [ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${anaKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[anaKey]).toBeUndefined();
    });

    it('leaves a key minted for another chat unresolved', async () => {
      const otherChatKey = matchedChatMemberKey('another-chat', ANA_ID);
      const { service } = buildService({
        eventMatchGroupId: 'match-group-1',
        seatUserIds: [VIEWER_ID, ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${otherChatKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[otherChatKey]).toBeUndefined();
    });

    it('leaves a key unresolved in a normal group', async () => {
      const { service } = buildService({
        eventMatchGroupId: null,
        seatUserIds: [VIEWER_ID, ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${anaKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[anaKey]).toBeUndefined();
    });
  });
});
