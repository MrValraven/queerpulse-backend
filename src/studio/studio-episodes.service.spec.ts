import { HttpException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import { StudioEpisodesService } from './studio-episodes.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { playableTrackSql } from './studio-playlist-visibility';
import { StudioReleaseCard } from './studio-response';
import { STUDIO_EPISODE_PUBLISHED } from './studio.events';

const USER_ID = 'f4000000-0000-4000-8000-000000000001';
const SHOW_ID = 'f4000000-0000-4000-8000-000000000002';
const TRACK_ID = 'f4000000-0000-4000-8000-000000000003';
const OTHER_TRACK = 'f4000000-0000-4000-8000-000000000004';
const AUDIO_KEY = 'studio-audio/a/b.mp3';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

function queryBuilderMock(rows: unknown[]) {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

const episodeRow = (
  id: string,
  publishedAt: Date | null,
  overrides: Partial<StudioTrack> = {},
): StudioTrack =>
  ({
    id,
    releaseId: SHOW_ID,
    position: 1,
    title: 'Housing in Lisbon',
    audioKey: AUDIO_KEY,
    audioContentType: 'audio/mpeg',
    durationSeconds: 1800,
    publishedAt,
    credits: [],
    lyrics: 'A long transcript',
    syncedLyrics: null,
    chapters: null,
    isExplicit: false,
    notes: '00:00 Intro',
    sources: [],
    ...overrides,
  }) as unknown as StudioTrack;

const showCard = {
  id: SHOW_ID,
  type: StudioReleaseType.Podcast,
  title: 'Lisbon After Dark',
} as StudioReleaseCard;

describe('StudioEpisodesService', () => {
  let show: Partial<StudioRelease>;
  let lockedTrack: StudioTrack | null;
  let manager: { findOne: jest.Mock; save: jest.Mock; query: jest.Mock };
  let ownership: { lockReleaseForWrite: jest.Mock };
  let catalog: { getTrack: jest.Mock; cardsByReleaseId: jest.Mock };
  let tracks: { createQueryBuilder: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let transaction: jest.Mock;
  let service: StudioEpisodesService;

  beforeEach(() => {
    show = {
      id: SHOW_ID,
      type: StudioReleaseType.Podcast,
      status: StudioReleaseStatus.Published,
    };
    lockedTrack = episodeRow(TRACK_ID, null);
    manager = {
      findOne: jest.fn((_entity: unknown, options: { select?: unknown }) =>
        Promise.resolve(
          options.select ? { id: TRACK_ID, releaseId: SHOW_ID } : lockedTrack,
        ),
      ),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      query: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release: show,
          persona: { id: 'persona-1', kind: 'podcaster' },
        }),
      ),
    };
    catalog = {
      getTrack: jest.fn().mockResolvedValue({ id: TRACK_ID }),
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(
            releaseIds
              .filter((releaseId) => releaseId === SHOW_ID)
              .map((releaseId) => [releaseId, showCard]),
          ),
        ),
      ),
    };
    tracks = { createQueryBuilder: jest.fn(() => queryBuilderMock([])) };
    blockFilter = {
      excludeBlocked: jest.fn((queryBuilder: unknown) => queryBuilder),
    };
    eventEmitter = { emit: jest.fn() };
    transaction = jest.fn((work: (inner: EntityManager) => unknown) =>
      Promise.resolve(work(manager as unknown as EntityManager)),
    );
    service = new StudioEpisodesService(
      { transaction } as unknown as DataSource,
      tracks as unknown as Repository<StudioTrack>,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      blockFilter as unknown as BlockFilterService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('publishEpisode', () => {
    it('publishes a draft episode, stamps it and emits the event after the commit', async () => {
      const before = Date.now();
      await service.publishEpisode(USER_ID, TRACK_ID);

      const saved = manager.save.mock.calls[0]![0] as StudioTrack;
      expect(saved.publishedAt).toBeInstanceOf(Date);
      expect(saved.publishedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(eventEmitter.emit).toHaveBeenCalledWith(STUDIO_EPISODE_PUBLISHED, {
        trackId: TRACK_ID,
      });
      expect(manager.save.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0]!,
      );
      // The version tools stay off a show: no release stamp is written.
      expect(manager.query).not.toHaveBeenCalled();
      expect(catalog.getTrack).toHaveBeenCalledWith(USER_ID, TRACK_ID);
    });

    it('locks the show before it reads the episode again', async () => {
      await service.publishEpisode(USER_ID, TRACK_ID);
      expect(ownership.lockReleaseForWrite).toHaveBeenCalledWith(
        manager,
        USER_ID,
        SHOW_ID,
      );
      expect(manager.findOne).toHaveBeenLastCalledWith(StudioTrack, {
        where: { id: TRACK_ID, releaseId: SHOW_ID },
      });
    });

    it.each([
      [
        'a show that is not out',
        () => {
          show = { ...show, status: StudioReleaseStatus.Draft };
        },
        'studio_episode_show_not_published',
      ],
      [
        'a track of a mix',
        () => {
          show = { ...show, type: StudioReleaseType.Mix };
        },
        'studio_not_a_podcast',
      ],
      [
        'an episode already out',
        () => {
          lockedTrack = episodeRow(
            TRACK_ID,
            new Date('2026-10-01T09:00:00.000Z'),
          );
        },
        'studio_episode_already_published',
      ],
      [
        'an episode whose audio is still uploading',
        () => {
          lockedTrack = episodeRow(TRACK_ID, null, {
            audioKey: null,
            durationSeconds: null,
          });
        },
        'studio_publish_tracks_pending',
      ],
    ])(
      'refuses %s and emits nothing',
      async (_label, arrange, expectedCode) => {
        arrange();
        expect(await codeOf(service.publishEpisode(USER_ID, TRACK_ID))).toBe(
          expectedCode,
        );
        expect(manager.save).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      },
    );

    it('answers 404 for an unknown track before any lock', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.publishEpisode(USER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(ownership.lockReleaseForWrite).not.toHaveBeenCalled();
    });
  });

  describe('listLatest', () => {
    it('reads published episodes of listenable shows, newest first, blocks applied', async () => {
      const feed = queryBuilderMock([]);
      tracks.createQueryBuilder.mockReturnValue(feed);

      await service.listLatest(USER_ID, undefined);

      expect(feed.where).toHaveBeenCalledWith(
        '"release"."type" = :podcastType',
        { podcastType: 'podcast' },
      );
      expect(feed.andWhere).toHaveBeenCalledWith(
        '"track"."published_at" IS NOT NULL',
      );
      expect(feed.andWhere).toHaveBeenCalledWith(
        playableTrackSql('track', 'release', 'persona'),
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        feed,
        USER_ID,
        '"persona"."user_id"',
      );
      expect(feed.orderBy).toHaveBeenCalledWith('track.publishedAt', 'DESC');
      expect(feed.addOrderBy).toHaveBeenCalledWith('track.id', 'DESC');
      expect(feed.limit).toHaveBeenCalledWith(13);
    });

    it('pages with the keyset cursor and answers the next one', async () => {
      const newest = episodeRow(TRACK_ID, new Date('2026-10-02T09:00:00.000Z'));
      const older = episodeRow(
        OTHER_TRACK,
        new Date('2026-10-01T09:00:00.000Z'),
      );
      tracks.createQueryBuilder.mockReturnValue(
        queryBuilderMock([newest, older]),
      );

      const firstPage = await service.listLatest(USER_ID, undefined, 1);

      expect(firstPage.items.map((item) => item.track.id)).toEqual([TRACK_ID]);
      expect(decodeStudioCursor(firstPage.nextCursor ?? undefined)).toEqual({
        publishedAt: new Date('2026-10-02T09:00:00.000Z'),
        id: TRACK_ID,
      });

      const secondFeed = queryBuilderMock([older]);
      tracks.createQueryBuilder.mockReturnValue(secondFeed);
      const cursor = encodeStudioCursor({
        publishedAt: new Date('2026-10-02T09:00:00.000Z'),
        id: TRACK_ID,
      });
      const secondPage = await service.listLatest(USER_ID, cursor, 1);

      expect(secondFeed.andWhere).toHaveBeenCalledWith(
        '("track"."published_at", "track"."id") < (:cursorPublishedAt, :cursorId)',
        {
          cursorPublishedAt: new Date('2026-10-02T09:00:00.000Z'),
          cursorId: TRACK_ID,
        },
      );
      expect(secondPage.nextCursor).toBeNull();
    });

    it('gives each item its show card and leaves the transcript and credits to the episode page', async () => {
      tracks.createQueryBuilder.mockReturnValue(
        queryBuilderMock([
          episodeRow(TRACK_ID, new Date('2026-10-02T09:00:00.000Z'), {
            credits: [{ name: 'Ines', role: 'Host' }],
          }),
        ]),
      );

      const page = await service.listLatest(USER_ID, undefined);

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.release).toBe(showCard);
      expect(page.items[0]?.track).toEqual(
        expect.objectContaining({
          id: TRACK_ID,
          lyrics: null,
          syncedLyrics: null,
          credits: [],
          personaCredits: [],
          notes: '00:00 Intro',
          publishedAt: '2026-10-02T09:00:00.000Z',
          isDraft: false,
        }),
      );
    });

    it('skips an episode whose show card is gone', async () => {
      tracks.createQueryBuilder.mockReturnValue(
        queryBuilderMock([
          episodeRow(TRACK_ID, new Date('2026-10-02T09:00:00.000Z'), {
            releaseId: 'f4000000-0000-4000-8000-0000000000ff',
          }),
        ]),
      );

      const page = await service.listLatest(USER_ID, undefined);

      expect(page.items).toEqual([]);
    });
  });
});
