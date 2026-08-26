import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import {
  FeedSourceKind,
  FeedSourceMute,
} from './entities/feed-source-mute.entity';
import { FeedMuteService } from './feed-mute.service';

/** Chainable insert-builder stub for the `orIgnore()` upsert path. */
interface InsertBuilderStub {
  insert: jest.Mock<InsertBuilderStub, unknown[]>;
  into: jest.Mock<InsertBuilderStub, unknown[]>;
  values: jest.Mock<InsertBuilderStub, unknown[]>;
  orIgnore: jest.Mock<InsertBuilderStub, unknown[]>;
  execute: jest.Mock<Promise<unknown>, []>;
}

function insertBuilderStub(): InsertBuilderStub {
  const builder: InsertBuilderStub = {
    insert: jest.fn<InsertBuilderStub, unknown[]>(),
    into: jest.fn<InsertBuilderStub, unknown[]>(),
    values: jest.fn<InsertBuilderStub, unknown[]>(),
    orIgnore: jest.fn<InsertBuilderStub, unknown[]>(),
    execute: jest.fn<Promise<unknown>, []>(),
  };
  builder.insert.mockReturnValue(builder);
  builder.into.mockReturnValue(builder);
  builder.values.mockReturnValue(builder);
  builder.orIgnore.mockReturnValue(builder);
  builder.execute.mockResolvedValue({});
  return builder;
}

describe('FeedMuteService', () => {
  let service: FeedMuteService;
  let mutes: {
    find: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communities: { find: jest.Mock; exist: jest.Mock };
  let forumThreads: { find: jest.Mock; exist: jest.Mock };
  let builder: InsertBuilderStub;

  const muteRow = (
    overrides: Partial<FeedSourceMute> = {},
  ): FeedSourceMute => ({
    id: 'mute-1',
    userId: 'viewer-1',
    sourceKind: FeedSourceKind.Community,
    sourceId: 'community-1',
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    builder = insertBuilderStub();
    mutes = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => builder),
    };
    communities = {
      find: jest.fn().mockResolvedValue([]),
      exist: jest.fn().mockResolvedValue(true),
    };
    forumThreads = {
      find: jest.fn().mockResolvedValue([]),
      exist: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedMuteService,
        { provide: getRepositoryToken(FeedSourceMute), useValue: mutes },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(ForumThread), useValue: forumThreads },
      ],
    }).compile();
    service = module.get(FeedMuteService);
  });

  it("groups a viewer's mutes by kind for the feed query", async () => {
    mutes.find.mockResolvedValue([
      muteRow({ sourceId: 'community-1' }),
      muteRow({
        id: 'mute-2',
        sourceKind: FeedSourceKind.ForumThread,
        sourceId: 'thread-1',
      }),
    ]);

    await expect(service.mutedSources('viewer-1')).resolves.toEqual({
      communityIds: ['community-1'],
      forumThreadIds: ['thread-1'],
    });
  });

  it('is idempotent: a second mute re-affirms the row instead of raising', async () => {
    await service.mute('viewer-1', FeedSourceKind.Community, 'community-1');

    expect(builder.orIgnore).toHaveBeenCalled();
    expect(builder.values).toHaveBeenCalledWith({
      userId: 'viewer-1',
      sourceKind: FeedSourceKind.Community,
      sourceId: 'community-1',
    });
  });

  it('never writes a membership row: muting is a feed preference only', async () => {
    await service.mute('viewer-1', FeedSourceKind.Community, 'community-1');

    // The only repositories this service holds are its own mute table plus
    // two READ-ONLY lookups. Nothing here can change a roster.
    expect(builder.into).toHaveBeenCalledWith(FeedSourceMute);
  });

  it('404s on a source that does not exist, so the list can never hold a dead row', async () => {
    communities.exist.mockResolvedValue(false);

    await expect(
      service.mute('viewer-1', FeedSourceKind.Community, 'nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('unmuting something that was never muted is a no-op, not an error', async () => {
    mutes.delete.mockResolvedValue({ affected: 0 });

    await expect(
      service.unmute('viewer-1', FeedSourceKind.Community, 'community-1'),
    ).resolves.toEqual({ muted: false });
  });

  it('resolves each muted source to a name and a link for the managed list', async () => {
    mutes.find.mockResolvedValue([
      muteRow({ sourceId: 'community-1' }),
      muteRow({
        id: 'mute-2',
        sourceKind: FeedSourceKind.ForumThread,
        sourceId: 'thread-1',
      }),
    ]);
    communities.find.mockResolvedValue([
      { id: 'community-1', name: 'Trans & NB Network', slug: 'trans-nb' },
    ]);
    forumThreads.find.mockResolvedValue([
      { id: 'thread-1', title: 'Best rooftop?', slug: 'best-rooftop' },
    ]);

    const list = await service.list('viewer-1');

    expect(list).toEqual([
      {
        sourceKind: FeedSourceKind.Community,
        sourceId: 'community-1',
        name: 'Trans & NB Network',
        link: '/community/trans-nb',
        mutedAt: '2026-08-10T00:00:00.000Z',
      },
      {
        sourceKind: FeedSourceKind.ForumThread,
        sourceId: 'thread-1',
        name: 'Best rooftop?',
        link: '/thread/best-rooftop',
        mutedAt: '2026-08-10T00:00:00.000Z',
      },
    ]);
  });

  it('drops a row whose subject no longer exists rather than showing a dead entry', async () => {
    mutes.find.mockResolvedValue([muteRow({ sourceId: 'gone' })]);
    communities.find.mockResolvedValue([]);

    await expect(service.list('viewer-1')).resolves.toEqual([]);
  });
});
