import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TopicPostLinkedEvent } from '../content/topic.events';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { TopicFollow } from './entities/topic-follow.entity';
import { TopicFollowNotificationsListener } from './topic-follow-notifications.listener';

const AUTHOR_ID = 'author-1';

function linkedEvent(isAuthorMasked: boolean): TopicPostLinkedEvent {
  return {
    topicId: 'topic-1',
    topicSlug: 'healthcare',
    topicLabel: 'healthcare',
    postId: 'post-1',
    threadSlug: 'finding-a-gp',
    threadTitle: 'Finding a GP',
    authorId: AUTHOR_ID,
    isAuthorMasked,
  };
}

describe('TopicFollowNotificationsListener', () => {
  let listener: TopicFollowNotificationsListener;
  let createForRecipients: jest.Mock;

  beforeEach(async () => {
    createForRecipients = jest.fn().mockResolvedValue([]);
    const follows = {
      find: jest
        .fn()
        .mockResolvedValue([{ userId: 'follower-1' }, { userId: AUTHOR_ID }]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TopicFollowNotificationsListener,
        { provide: getRepositoryToken(TopicFollow), useValue: follows },
        { provide: NotificationsService, useValue: { createForRecipients } },
      ],
    }).compile();
    listener = module.get(TopicFollowNotificationsListener);
  });

  const onlyCall = (): [
    string[],
    NotificationType,
    Record<string, unknown>,
    string | undefined,
  ] => {
    const calls = createForRecipients.mock.calls as unknown as Array<
      [string[], NotificationType, Record<string, unknown>, string | undefined]
    >;
    const firstCall = calls[0];
    if (!firstCall) throw new Error('expected a fan-out, none was made');
    return firstCall;
  };

  it('listener omits actorId for a masked author and still passes it for block filtering', async () => {
    await listener.onTopicPostLinked(linkedEvent(true));

    const [recipientIds, type, payload, blockFilterActorId] = onlyCall();
    expect(recipientIds).toEqual(['follower-1']);
    expect(type).toBe(NotificationType.TopicNewPost);
    expect(payload).not.toHaveProperty('actorId');
    expect(payload).toMatchObject({
      source: 'forum',
      threadSlug: 'finding-a-gp',
    });
    expect(blockFilterActorId).toBe(AUTHOR_ID);
  });

  it('listener names the author as actor when the byline is their own', async () => {
    await listener.onTopicPostLinked(linkedEvent(false));

    const [, , payload, blockFilterActorId] = onlyCall();
    expect(payload.actorId).toBe(AUTHOR_ID);
    expect(blockFilterActorId).toBe(AUTHOR_ID);
  });
});
