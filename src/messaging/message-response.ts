import { Profile } from '../users/entities/profile.entity';
import { Message } from './entities/message.entity';

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

export interface ConversationMemberView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface ConversationSummary {
  id: string;
  isOfficial: boolean;
  otherMember: ConversationMemberView | null;
  lastMessage: {
    id: string;
    senderId: string;
    body: string;
    createdAt: Date;
  } | null;
  unreadCount: number;
  muted: boolean;
}

export function toMessageView(m: Message): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    body: m.body,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  };
}

export function toConversationMemberView(
  p: Profile | undefined,
): ConversationMemberView | null {
  if (!p) {
    return null;
  }
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    avatarUrl: p.avatarUrl,
  };
}
