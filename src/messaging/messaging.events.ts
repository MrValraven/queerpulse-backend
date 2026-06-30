import { MessageView } from './message-response';

export const MESSAGE_CREATED = 'message.created';
export const MESSAGE_READ = 'message.read';

export interface MessageCreatedEvent {
  conversationId: string;
  message: MessageView;
}

export interface MessageReadEvent {
  conversationId: string;
  userId: string;
  lastReadAt: Date;
}
