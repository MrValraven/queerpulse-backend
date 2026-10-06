import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { renderMatchedChatMentions } from './matched-member-key';

/** Renders one conversation's text with its `@<member key>` tokens named. */
export type MatchedChatMentionRenderer = (
  conversationId: string,
  text: string,
) => string;

/**
 * PRD-423 (opaque member keys): a {@link MatchedChatMentionRenderer} for the
 * matched Go together chats `conversationIds`, with every seat and first
 * name read in two batched queries. Text from any other conversation comes
 * back unchanged. Callers pass only matched chats whose text carries a key
 * (`hasMatchedChatMentions`), so an ordinary read costs nothing.
 */
export async function loadMatchedChatMentionRenderer(
  repositories: {
    participants: Pick<Repository<ConversationParticipant>, 'find'>;
    profiles: Pick<Repository<Profile>, 'find'>;
  },
  conversationIds: Iterable<string>,
): Promise<MatchedChatMentionRenderer> {
  const uniqueConversationIds = [...new Set(conversationIds)];
  if (!uniqueConversationIds.length) return (_conversationId, text) => text;
  const seats = await repositories.participants.find({
    where: { conversationId: In(uniqueConversationIds) },
    select: { conversationId: true, userId: true },
  });
  const seatUserIds = [...new Set(seats.map((seat) => seat.userId))];
  const profiles = seatUserIds.length
    ? await repositories.profiles.find({
        where: { userId: In(seatUserIds) },
        select: { userId: true, firstName: true },
      })
    : [];
  return matchedChatMentionRendererFrom(seats, profiles);
}

/** {@link loadMatchedChatMentionRenderer} over seats and profiles a caller
 *  already holds, so a read that loaded them costs no query at all. */
export function matchedChatMentionRendererFrom(
  seats: ReadonlyArray<
    Pick<ConversationParticipant, 'conversationId' | 'userId'>
  >,
  profiles: ReadonlyArray<Pick<Profile, 'userId' | 'firstName'>>,
): MatchedChatMentionRenderer {
  const seatUserIdsByConversation = new Map<string, string[]>();
  for (const seat of seats) {
    const seatUserIds = seatUserIdsByConversation.get(seat.conversationId);
    if (seatUserIds) seatUserIds.push(seat.userId);
    else seatUserIdsByConversation.set(seat.conversationId, [seat.userId]);
  }
  const firstNameByUserId = new Map(
    profiles.map((profile) => [profile.userId, profile.firstName]),
  );
  return (conversationId, text) => {
    const seatUserIds = seatUserIdsByConversation.get(conversationId);
    return seatUserIds
      ? renderMatchedChatMentions(
          text,
          conversationId,
          seatUserIds,
          firstNameByUserId,
        )
      : text;
  };
}
