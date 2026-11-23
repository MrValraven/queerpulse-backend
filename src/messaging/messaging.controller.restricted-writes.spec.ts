import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { ConversationsController } from './messaging.controller';

/**
 * SEC-27: a member under a moderation restriction cannot rewrite a message
 * or add a reaction, since both go out live to every participant. Removing
 * their own reaction and deleting their own message stay open.
 */
function guardsOf(handlerName: keyof ConversationsController): unknown[] {
  const handler: unknown = ConversationsController.prototype[handlerName];
  if (typeof handler !== 'function') {
    throw new Error(`${String(handlerName)} is not a route handler`);
  }
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, handler);
  return Array.isArray(guards) ? guards : [];
}

describe('ConversationsController restricted-member writes (SEC-27)', () => {
  it.each(['editMessage', 'addReaction'] as const)(
    'binds NotRestrictedGuard to %s',
    (handlerName) => {
      expect(guardsOf(handlerName)).toContain(NotRestrictedGuard);
    },
  );

  it.each(['removeReaction', 'deleteMessage'] as const)(
    'leaves %s open to a restricted member',
    (handlerName) => {
      expect(guardsOf(handlerName)).not.toContain(NotRestrictedGuard);
    },
  );
});
