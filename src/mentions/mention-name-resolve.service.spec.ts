import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Listing } from '../listings/entities/listing.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
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
  const profileQuery = {
    innerJoin: () => profileQuery,
    where: () => profileQuery,
    getMany: () => Promise.resolve(PROFILES),
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
  return { service, conversations };
}

const REFS = ['member:ana-sousa', 'member:rui-lopes'];

function nameBySlug(resolved: { slug: string; name: string }[]) {
  return Object.fromEntries(resolved.map((entry) => [entry.slug, entry.name]));
}

describe('MentionNameResolveService, matched Go together chats (PRD-423)', () => {
  it('names a matched chat member by first name for a viewer seated in it', async () => {
    const { service } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    expect(nameBySlug(resolved)).toEqual({
      'ana-sousa': 'Ana',
      'rui-lopes': 'Rui Lopes',
    });
  });

  it('keeps first names in a Go together chat whose group row is gone', async () => {
    const { service } = buildService({
      eventMatchGroupId: null,
      isGoTogetherChat: true,
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana');
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
});
