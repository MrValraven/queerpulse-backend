import { MessageView } from './message-response';

export const MESSAGE_CREATED = 'message.created';
export const MESSAGE_UPDATED = 'message.updated';
export const MESSAGE_READ = 'message.read';
export const MESSAGE_REACTION = 'message.reaction';
export const MESSAGE_DELETED = 'message.deleted';

export interface MessageCreatedEvent {
  conversationId: string;
  message: MessageView;
}

export interface MessageUpdatedEvent {
  conversationId: string;
  message: MessageView;
}

export interface MessageReadEvent {
  conversationId: string;
  userId: string;
  lastReadAt: Date;
}

export interface MessageReactionEvent {
  conversationId: string;
  messageId: string;
}

export interface MessageDeletedEvent {
  conversationId: string;
  messageId: string;
}
