import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { GifAttachment, Message } from './entities/message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { MessagingCoreService } from './messaging-core.service';

/**
 * M8 — the client-controlled `forwarded` flag must NOT bypass the attachment
 * ownership check. Whether an image attachment the sender does not own may be
 * sent is derived server-side (does an accessible image message already carry
 * that exact key?), never from the boolean the client asserts.
 */
const SENDER = '11111111-1111-1111-1111-111111111111';
const OTHER_UPLOADER = '22222222-2222-2222-2222-222222222222';
const ASSET_UUID = '33333333-3333-3333-3333-333333333333';

// A well-formed `message-image` key whose embedded uploader id is NOT the
// sender (so the "own upload" branch never applies — only a genuine forward
// could legitimise it).
const FOREIGN_KEY = `message-images/${OTHER_UPLOADER}/${ASSET_UUID}.jpg`;
// A key the sender genuinely uploaded (embedded owner id === sender).
const OWN_KEY = `message-images/${SENDER}/${ASSET_UUID}.jpg`;

function imageAttachment(key: string): GifAttachment {
  return {
    url: key,
    previewUrl: key,
    width: 10,
    height: 10,
    provider: 'upload',
  };
}

function build(accessibleForwardCount: number) {
  const getCount = jest.fn().mockResolvedValue(accessibleForwardCount);
  const queryBuilder = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount,
  };
  const messages = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn(() => queryBuilder),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: Record<string, unknown>) =>
      Promise.resolve({ id: 'saved-message-id', ...entity }),
    ),
  };
  const empty = {} as Record<string, never>;
  const service = new MessagingCoreService(
    empty as unknown as Repository<Conversation>,
    empty as unknown as Repository<ConversationParticipant>,
    messages as unknown as Repository<Message>,
    empty as unknown as Repository<MessageReaction>,
    empty as unknown as Repository<ConversationPinnedMessage>,
    empty as unknown as Repository<MessageStar>,
    empty as unknown as Repository<ContentModeration>,
    empty as unknown as Repository<Profile>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    empty as unknown as UsersService,
  );
  // Short-circuit the hydration that a genuinely-accepted send would run — this
  // suite only asserts the ownership/forward decision, not the response shape.
  const buildPostResult = jest
    .spyOn(service, 'buildPostResult')
    .mockResolvedValue({
      view: {} as never,
      response: {} as never,
      isNew: true,
    });
  return { service, messages, getCount, buildPostResult };
}

describe('MessagingCoreService.postMessage — image attachment ownership (M8)', () => {
  it('still rejects a foreign attachment when forwarded:true but no accessible source exists', async () => {
    const { service, buildPostResult } = build(0);

    await expect(
      service.postMessage(
        'conversation-1',
        SENDER,
        'here you go',
        undefined,
        undefined,
        true, // client asserts forwarded — must NOT be trusted
        'image',
        imageAttachment(FOREIGN_KEY),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(buildPostResult).not.toHaveBeenCalled();
  });

  it('rejects a foreign attachment on a fresh (non-forward) send', async () => {
    const { service } = build(0);

    await expect(
      service.postMessage(
        'conversation-1',
        SENDER,
        'here you go',
        undefined,
        undefined,
        false,
        'image',
        imageAttachment(FOREIGN_KEY),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a foreign attachment ONLY when an accessible source message proves genuine access — even with forwarded:false', async () => {
    const { service, getCount, buildPostResult } = build(1);

    await service.postMessage(
      'conversation-1',
      SENDER,
      'forwarding this',
      undefined,
      undefined,
      false, // the flag is irrelevant: server-derived access is what matters
      'image',
      imageAttachment(FOREIGN_KEY),
    );

    expect(getCount).toHaveBeenCalledTimes(1);
    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });

  it("skips the forward lookup entirely for the sender's own upload", async () => {
    const { service, messages, buildPostResult } = build(0);

    await service.postMessage(
      'conversation-1',
      SENDER,
      'my own photo',
      undefined,
      undefined,
      false,
      'image',
      imageAttachment(OWN_KEY),
    );

    // Owner match short-circuits before any accessible-forward query runs.
    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    expect(buildPostResult).toHaveBeenCalledTimes(1);
  });
});
