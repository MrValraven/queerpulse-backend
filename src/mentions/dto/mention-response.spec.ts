import {
  Notification,
  NotificationType,
} from '../../notifications/entities/notification.entity';
import { Profile } from '../../users/entities/profile.entity';
import { MentionResolvers, toMentionResponse } from './mention-response';

/**
 * PRD-423: a mention written inside a Go together chat reaches the Mentions
 * inbox with the mentioner's first name alone and no profile link, the way
 * the chat itself introduces its members. Every other mention keeps the full
 * name and the link.
 */

const ANA = {
  userId: 'ana-1',
  slug: 'ana-sousa',
  firstName: 'Ana ',
  lastName: 'Sousa',
  avatarUrl: null,
  photoVisible: true,
} as unknown as Profile;

function mentionRow(payload: Record<string, unknown>): Notification {
  return {
    id: 'mention-1',
    userId: 'viewer-1',
    type: NotificationType.Mention,
    payload: { actorId: ANA.userId, excerpt: 'see you there', ...payload },
    read: false,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

const RESOLVERS: MentionResolvers = {
  profileByUserId: new Map([[ANA.userId, ANA]]),
  threadTitleBySlug: new Map(),
  communityNameBySlug: new Map(),
  staleExcerptNotificationIds: new Set(),
};

describe('toMentionResponse, Go together chats (PRD-423)', () => {
  it('names the mentioner by first name with no profile link', () => {
    const response = toMentionResponse(
      mentionRow({
        source: 'message',
        conversationId: 'conversation-1',
        isGoTogetherChat: true,
      }),
      RESOLVERS,
    );

    expect(response.actor).toEqual({
      slug: '',
      firstName: 'Ana',
      lastName: '',
      avatarUrl: null,
    });
  });

  it('keeps the full name and link for a mention in an ordinary chat', () => {
    const response = toMentionResponse(
      mentionRow({ source: 'message', conversationId: 'conversation-1' }),
      RESOLVERS,
    );

    expect(response.actor).toMatchObject({
      slug: 'ana-sousa',
      lastName: 'Sousa',
    });
  });

  it('reads the key on message mentions only', () => {
    const response = toMentionResponse(
      mentionRow({ source: 'forum', isGoTogetherChat: true }),
      RESOLVERS,
    );

    expect(response.actor).toMatchObject({
      slug: 'ana-sousa',
      lastName: 'Sousa',
    });
  });
});
