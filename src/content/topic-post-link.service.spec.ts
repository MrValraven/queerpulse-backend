import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Profile } from '../users/entities/profile.entity';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import { TopicPostLinkService } from './topic-post-link.service';
import { TOPIC_POST_LINKED, TopicPostLinkedEvent } from './topic.events';

const AUTHOR_ID = 'author-1';

function makeThread(overrides: Partial<ForumThread>): ForumThread {
  // Only the columns `linkThread` reads; the cast keeps the fixture short.
  return {
    id: 'thread-1',
    slug: 'finding-a-gp',
    title: 'Finding a GP',
    tags: ['healthcare'],
    authorId: AUTHOR_ID,
    isAnonymous: false,
    isOfficial: false,
    ...overrides,
  } as ForumThread;
}

describe('TopicPostLinkService.linkThread', () => {
  let service: TopicPostLinkService;
  let topicPosts: { create: jest.Mock; save: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let emit: jest.Mock;

  beforeEach(async () => {
    const topics = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'topic-1', tag: 'healthcare', label: 'healthcare' },
        ]),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    topicPosts = {
      create: jest.fn((row: Partial<TopicPost>) => row),
      save: jest.fn((rows: Partial<TopicPost>[]) =>
        Promise.resolve(
          rows.map((row, index) => ({ ...row, id: `post-${index}` })),
        ),
      ),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue({
        userId: AUTHOR_ID,
        firstName: 'Rita',
        lastName: 'Sousa',
        slug: 'rita-sousa',
      }),
    };
    emit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TopicPostLinkService,
        { provide: getRepositoryToken(Topic), useValue: topics },
        { provide: getRepositoryToken(TopicPost), useValue: topicPosts },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    service = module.get(TopicPostLinkService);
  });

  const savedRow = (): Partial<TopicPost> => {
    const calls = topicPosts.save.mock.calls as unknown as Array<
      [Partial<TopicPost>[]]
    >;
    const firstRow = calls[0]?.[0][0];
    if (!firstRow) throw new Error('expected a topic post row, none was saved');
    return firstRow;
  };

  const emittedEvent = (): TopicPostLinkedEvent => {
    const calls = emit.mock.calls as unknown as Array<
      [string, TopicPostLinkedEvent]
    >;
    const firstCall = calls[0];
    if (!firstCall) throw new Error('expected an event, none was emitted');
    expect(firstCall[0]).toBe(TOPIC_POST_LINKED);
    return firstCall[1];
  };

  it('linkThread stores the anonymous byline for an anonymous thread', async () => {
    await service.linkThread(makeThread({ isAnonymous: true }), 'Any tips?');

    expect(savedRow()).toMatchObject({
      authorName: 'Anonymous member',
      authorInitials: 'A',
      authorTone: 'plum',
      // The real writer stays on the row for block and mute filtering.
      authorId: AUTHOR_ID,
    });
    expect(profiles.findOne).not.toHaveBeenCalled();
    expect(emittedEvent()).toMatchObject({
      authorId: AUTHOR_ID,
      isAuthorMasked: true,
    });
  });

  it('linkThread stores the QueerPulse byline for an official thread', async () => {
    await service.linkThread(
      makeThread({ isOfficial: true, isAnonymous: true }),
      'House rules',
    );

    expect(savedRow()).toMatchObject({
      authorName: 'QueerPulse',
      authorInitials: 'QP',
      authorTone: 'plum',
      authorId: AUTHOR_ID,
    });
    expect(emittedEvent().isAuthorMasked).toBe(true);
  });

  it('linkThread stores the member byline for a plain thread', async () => {
    await service.linkThread(makeThread({}), 'Any tips?');

    expect(savedRow()).toMatchObject({
      authorName: 'Rita Sousa',
      authorInitials: 'RS',
      authorId: AUTHOR_ID,
    });
    expect(emittedEvent().isAuthorMasked).toBe(false);
  });
});
