import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../../common/image-url';
import { NotificationType } from '../../notifications/entities/notification.entity';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { PersonaImageKeysService } from '../../storage/persona-image-keys.service';
import type { StorageService } from '../../storage/storage.service';
import { User, UserStatus } from '../../users/entities/user.entity';
import { SubprofileFeedEntry } from '../entities/subprofile-feed-entry.entity';
import { SubprofileFeed } from '../entities/subprofile-feed.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from '../entities/subprofile-item.entity';
import { SubprofileMember } from '../entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
} from '../entities/subprofile.entity';
import type {
  SubprofilesService,
  TopInsertCandidate,
} from '../subprofiles.service';
import { FeedFetchError } from './feed-fetch';
import {
  MAX_ART_DOWNLOADS_PER_PUBLISH,
  SubprofileFeedsService,
} from './subprofile-feeds.service';

const PERSONA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FEED_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CO_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SHOW_ART_KEY = `work/${OWNER_ID}/33333333-3333-4333-8333-333333333333.jpg`;
const NOW = new Date('2026-09-30T12:00:00Z');

function makeFeed(overrides: Partial<SubprofileFeed> = {}): SubprofileFeed {
  return {
    id: FEED_ID,
    subprofileId: PERSONA_ID,
    createdById: OWNER_ID,
    feedUrl: 'https://feeds.example/show',
    section: SubprofileSection.Episodes,
    title: 'The Show',
    author: 'Robin',
    imageKey: SHOW_ART_KEY,
    autoPublish: false,
    etag: '"v1"',
    lastModified: null,
    lastSyncedAt: null,
    lastAttemptAt: null,
    nextCheckAt: NOW,
    consecutiveFailures: 0,
    lastError: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function makeEntry(
  id: string,
  publishedAt: string | null,
  overrides: Partial<SubprofileFeedEntry> = {},
): SubprofileFeedEntry {
  return {
    id,
    feedId: FEED_ID,
    subprofileId: PERSONA_ID,
    guid: `guid-${id}`,
    title: `Episode ${id}`,
    description: null,
    link: `https://feeds.example/${id}`,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
    durationSeconds: 2880,
    season: null,
    episode: null,
    remoteImageUrl: null,
    status: 'pending',
    itemId: null,
    createdAt: new Date('2026-09-02T00:00:00Z'),
    ...overrides,
  };
}

function makePersona(): Subprofile {
  return {
    id: PERSONA_ID,
    userId: OWNER_ID,
    kind: SubprofileKind.Developer,
    displayName: 'Night Radio',
    handle: 'nightradio',
    slug: 'night-radio',
    editVersion: 7,
  } as Subprofile;
}

const rss = (items: string, channelExtra = ''): string =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>The Show</title><itunes:author>Robin</itunes:author>${channelExtra}${items}</channel></rss>`;
const item = (guid: string, date: string, extra = ''): string =>
  `<item><title>Ep ${guid}</title><guid>${guid}</guid><pubDate>${date}</pubDate>${extra}</item>`;

describe('SubprofileFeedsService', () => {
  let feeds: {
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    manager: { count: jest.Mock };
    createQueryBuilder: jest.Mock;
  };
  let entries: {
    find: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
    manager: EntityManagerFake;
    createQueryBuilder: jest.Mock;
  };
  let items: { count: jest.Mock };
  let members: { exists: jest.Mock; find: jest.Mock };
  let subprofileRepo: { findOne: jest.Mock };
  let users: { findOne: jest.Mock };
  let subprofilesService: {
    getOwned: jest.Mock;
    getOwnedDTO: jest.Mock;
    insertItemsAtTop: jest.Mock;
  };
  let storage: {
    putServerObject: jest.Mock;
    putPersonaServerObject: jest.Mock;
  };
  let personaImageKeys: {
    registerKey: jest.Mock;
    rehomeForPersonaWrite: jest.Mock;
  };
  let notifications: { createForRecipients: jest.Mock };
  let fetcher: { fetchFeed: jest.Mock; fetchImage: jest.Mock };
  let txManager: EntityManagerFake;
  let dataSource: { transaction: jest.Mock; manager: EntityManagerFake };
  let service: SubprofileFeedsService;
  /** What the (fake) persona lock re-read returns as still pending. */
  let stillPendingUnderLock: ((ids: string[]) => string[]) | null;
  let insertedValues: Record<string, unknown>[];

  interface EntityManagerFake {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  }

  function makeManager(): EntityManagerFake {
    return {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: Record<string, unknown>) =>
        Promise.resolve({ ...row, id: FEED_ID }),
      ),
      create: jest.fn((_entity: unknown, value: unknown) => value),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // The idempotent entry insert: records the rows and "returns" an id for
      // each one.
      createQueryBuilder: jest.fn(() => {
        let values: Record<string, unknown>[] = [];
        const chain = {
          insert: () => chain,
          into: () => chain,
          values: (rows: Record<string, unknown>[]) => {
            values = rows;
            insertedValues.push(...rows);
            return chain;
          },
          orIgnore: () => chain,
          returning: () => chain,
          execute: () =>
            Promise.resolve({
              raw: values.map((row) => ({ id: `new-${String(row.guid)}` })),
            }),
        };
        return chain;
      }),
    };
  }

  function countsQuery(
    rows: { feedId: string; status: string; count: number }[],
  ) {
    const chain = {
      select: () => chain,
      addSelect: () => chain,
      where: () => chain,
      andWhere: () => chain,
      groupBy: () => chain,
      addGroupBy: () => chain,
      getRawMany: () => Promise.resolve(rows),
    };
    return chain;
  }

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  beforeEach(() => {
    // Feed DTOs resolve our stored show-art key through `toImageUrl`.
    setImageUrlBase('https://api.test');
    insertedValues = [];
    stillPendingUnderLock = null;
    txManager = makeManager();
    feeds = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(makeFeed()),
      exists: jest.fn().mockResolvedValue(false),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: { count: jest.fn().mockResolvedValue(0) },
      createQueryBuilder: jest.fn(() => {
        const chain = {
          update: () => chain,
          set: () => chain,
          where: () => chain,
          andWhere: () => chain,
          execute: () => Promise.resolve({ affected: 1 }),
        };
        return chain;
      }),
    };
    entries = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 2 }),
      count: jest.fn().mockResolvedValue(0),
      manager: makeManager(),
      createQueryBuilder: jest.fn(() => countsQuery([])),
    };
    items = { count: jest.fn().mockResolvedValue(3) };
    members = {
      exists: jest.fn().mockResolvedValue(true),
      find: jest
        .fn()
        .mockResolvedValue([{ userId: OWNER_ID }, { userId: CO_OWNER_ID }]),
    };
    subprofileRepo = { findOne: jest.fn().mockResolvedValue(makePersona()) };
    users = {
      findOne: jest.fn().mockResolvedValue({
        id: OWNER_ID,
        status: UserStatus.Active,
        restricted: false,
        restrictedUntil: null,
      }),
    };
    subprofilesService = {
      getOwned: jest.fn().mockResolvedValue(makePersona()),
      getOwnedDTO: jest.fn().mockResolvedValue({ id: PERSONA_ID }),
      // Drives the caller's callbacks the way the real method does: select
      // under the lock, insert, then hand back the item ids.
      insertItemsAtTop: jest.fn(
        async (
          _userId: string,
          _subprofileId: string,
          _section: SubprofileSection,
          options: {
            selectCandidates: (
              manager: EntityManager,
            ) => Promise<TopInsertCandidate<string>[]>;
            onInserted: (
              manager: EntityManager,
              inserted: { ref: string; itemId: string }[],
            ) => Promise<void>;
          },
        ) => {
          const candidates = await options.selectCandidates(
            txManager as unknown as EntityManager,
          );
          await options.onInserted(
            txManager as unknown as EntityManager,
            candidates.map((candidate, index) => ({
              ref: candidate.ref,
              itemId: `item-${index}`,
            })),
          );
          return {
            inserted: candidates.length,
            subprofile: { id: PERSONA_ID, editVersion: 8 },
          };
        },
      ),
    };
    // The locked re-read of the entries about to be published.
    txManager.find.mockImplementation(
      (entity: unknown, options: { where: { id?: { value: string[] } } }) => {
        // Only the locked re-read filters by id; the known-guid lookup of an
        // entry insert finds nothing recorded yet.
        if (entity !== SubprofileFeedEntry || !options.where.id) {
          return Promise.resolve([]);
        }
        const ids = options.where.id.value;
        const pending = stillPendingUnderLock
          ? stillPendingUnderLock(ids)
          : ids;
        return Promise.resolve(pending.map((id) => ({ id })));
      },
    );
    storage = {
      putServerObject: jest.fn((_kind: string, owner: string) =>
        Promise.resolve(
          `work/${owner}/44444444-4444-4444-8444-${String(
            storage.putServerObject.mock.calls.length,
          ).padStart(12, '0')}.png`,
        ),
      ),
      putPersonaServerObject: jest
        .fn()
        .mockResolvedValue(
          'persona/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666.png',
        ),
    };
    // Default: the in-lock re-check finds nothing to re-home.
    personaImageKeys = {
      registerKey: jest.fn().mockResolvedValue(undefined),
      rehomeForPersonaWrite: jest.fn().mockResolvedValue(new Map()),
    };
    notifications = { createForRecipients: jest.fn().mockResolvedValue([]) };
    fetcher = {
      fetchFeed: jest.fn(),
      fetchImage: jest.fn().mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    };
    dataSource = {
      transaction: jest.fn(
        (run: (manager: EntityManagerFake) => Promise<unknown>) =>
          run(txManager),
      ),
      manager: txManager,
    };
    service = new SubprofileFeedsService(
      feeds as unknown as Repository<SubprofileFeed>,
      entries as unknown as Repository<SubprofileFeedEntry>,
      items as unknown as Repository<SubprofileItem>,
      members as unknown as Repository<SubprofileMember>,
      subprofileRepo as unknown as Repository<Subprofile>,
      users as unknown as Repository<User>,
      subprofilesService as unknown as SubprofilesService,
      storage as unknown as StorageService,
      notifications as unknown as NotificationsService,
      fetcher,
      dataSource as unknown as DataSource,
      personaImageKeys as unknown as PersonaImageKeysService,
    );
  });

  // T17: an unlinked persona's art must not be stored under a key that
  // carries the publishing member's id.
  describe('art for an unlinked persona', () => {
    it('stores episode art under a persona-scoped key registered to the persona', async () => {
      subprofileRepo.findOne.mockResolvedValue({
        ...makePersona(),
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      });
      entries.find.mockResolvedValue([
        makeEntry('new', '2026-03-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/art.jpg',
        }),
      ]);

      await service.publishEntries(makeFeed(), CO_OWNER_ID, ['new'], 7);

      expect(storage.putServerObject).not.toHaveBeenCalled();
      expect(storage.putPersonaServerObject).toHaveBeenCalledWith(
        'work-image',
        expect.any(Uint8Array),
        'image/png',
      );
      expect(personaImageKeys.registerKey).toHaveBeenCalledWith(
        txManager,
        'persona/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666.png',
        PERSONA_ID,
        CO_OWNER_ID,
        'work-image',
      );
    });

    it('keeps the member-scoped key for a linked persona', async () => {
      subprofileRepo.findOne.mockResolvedValue({
        ...makePersona(),
        linkVisibility: SubprofileLinkVisibility.Linked,
      });
      entries.find.mockResolvedValue([
        makeEntry('new', '2026-03-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/art.jpg',
        }),
      ]);

      await service.publishEntries(makeFeed(), CO_OWNER_ID, ['new'], 7);

      expect(storage.putPersonaServerObject).not.toHaveBeenCalled();
      expect(storage.putServerObject).toHaveBeenCalledWith(
        'work-image',
        CO_OWNER_ID,
        expect.any(Uint8Array),
        'image/png',
      );
    });
  });

  describe('publishEntries', () => {
    it('publishes newest first, dedupes art downloads and falls back to the show art', async () => {
      entries.find.mockResolvedValue([
        makeEntry('old', '2026-01-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/shared.jpg',
        }),
        makeEntry('new', '2026-03-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/shared.jpg',
          season: 2,
          episode: 14,
        }),
        makeEntry('bare', '2026-02-01T00:00:00Z'),
      ]);

      const result = await service.publishEntries(
        makeFeed(),
        CO_OWNER_ID,
        ['new', 'old', 'bare', 'not-a-pending-entry'],
        7,
      );

      // One download for the art both episodes share, stored as the
      // PUBLISHING member's key.
      expect(fetcher.fetchImage).toHaveBeenCalledTimes(1);
      expect(storage.putServerObject).toHaveBeenCalledWith(
        'work-image',
        CO_OWNER_ID,
        expect.any(Uint8Array),
        'image/png',
      );
      const [editor, personaId, section, options] = subprofilesService
        .insertItemsAtTop.mock.calls[0] as [
        string,
        string,
        SubprofileSection,
        { expectedEditVersion?: number },
      ];
      expect([editor, personaId, section]).toEqual([
        CO_OWNER_ID,
        PERSONA_ID,
        SubprofileSection.Episodes,
      ]);
      expect(options.expectedEditVersion).toBe(7);

      const entryUpdates = txManager.update.mock.calls as [
        unknown,
        { id: string },
        { status: string; itemId: string },
      ][];
      expect(
        entryUpdates.map(([, where, patch]) => [
          where.id,
          patch.status,
          patch.itemId,
        ]),
      ).toEqual([
        ['new', 'published', 'item-0'],
        ['bare', 'published', 'item-1'],
        ['old', 'published', 'item-2'],
      ]);
      expect(result).toEqual({
        published: 3,
        skipped: 1,
        subprofile: { id: PERSONA_ID, editVersion: 8 },
      });
    });

    it('maps each episode onto the item fields, never the remote art URL', async () => {
      entries.find.mockResolvedValue([
        makeEntry('a', '2026-03-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/a.jpg',
          season: 2,
          episode: 14,
        }),
        makeEntry('b', '2026-02-01T00:00:00Z'),
      ]);
      let captured: TopInsertCandidate<string>[] = [];
      subprofilesService.insertItemsAtTop.mockImplementationOnce(
        async (
          _u: string,
          _s: string,
          _sec: SubprofileSection,
          options: {
            selectCandidates: (
              m: EntityManager,
            ) => Promise<TopInsertCandidate<string>[]>;
          },
        ) => {
          captured = await options.selectCandidates(
            txManager as unknown as EntityManager,
          );
          return { inserted: 0, subprofile: {} };
        },
      );
      await service.publishEntries(makeFeed(), OWNER_ID, ['a', 'b']);
      const [withArt, withoutArt] = captured.map(
        (candidate) => candidate.fields,
      );
      expect(withArt?.imageUrl).toMatch(/^work\//);
      expect({ ...withArt, imageUrl: 'stored' }).toEqual({
        title: 'Episode a',
        subtitle: 'S2 · E14',
        description: null,
        url: 'https://feeds.example/a',
        date: '2026-03',
        meta: '48 min',
        imageUrl: 'stored',
      });
      expect(withoutArt).toEqual(
        expect.objectContaining({ subtitle: null, imageUrl: SHOW_ART_KEY }),
      );
      expect(JSON.stringify(captured)).not.toContain('cdn.example');
    });

    it('answers 422 SECTION_FULL before downloading anything', async () => {
      entries.find.mockResolvedValue([makeEntry('a', null)]);
      items.count.mockResolvedValue(100);
      const error: unknown = await service
        .publishEntries(makeFeed(), OWNER_ID, ['a'])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'SECTION_FULL' }),
      );
      expect(fetcher.fetchImage).not.toHaveBeenCalled();
      expect(subprofilesService.insertItemsAtTop).not.toHaveBeenCalled();
    });

    it('prepares only what fits, newest first; the rest stay pending as skipped', async () => {
      items.count.mockResolvedValue(99);
      entries.find.mockResolvedValue([
        makeEntry('older', '2026-01-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/older.jpg',
        }),
        makeEntry('newest', '2026-05-01T00:00:00Z', {
          remoteImageUrl: 'https://cdn.example/newest.jpg',
        }),
      ]);
      const result = await service.publishEntries(makeFeed(), OWNER_ID, [
        'older',
        'newest',
      ]);
      expect(fetcher.fetchImage).toHaveBeenCalledTimes(1);
      expect(fetcher.fetchImage).toHaveBeenCalledWith(
        'https://cdn.example/newest.jpg',
      );
      expect(result.published).toBe(1);
      expect(result.skipped).toBe(1);
      expect(txManager.update).toHaveBeenCalledTimes(1);
    });

    it('skips entries a concurrent publish or dismiss took under the lock', async () => {
      entries.find.mockResolvedValue([
        makeEntry('a', '2026-03-01T00:00:00Z'),
        makeEntry('b', '2026-02-01T00:00:00Z'),
      ]);
      stillPendingUnderLock = (ids) => ids.filter((id) => id !== 'a');
      const result = await service.publishEntries(makeFeed(), OWNER_ID, [
        'a',
        'b',
      ]);
      expect(result).toEqual(
        expect.objectContaining({ published: 1, skipped: 1 }),
      );
    });

    it('returns the persona unchanged when nothing requested is pending', async () => {
      entries.find.mockResolvedValue([]);
      const result = await service.publishEntries(makeFeed(), OWNER_ID, [
        'x',
        'x',
        'y',
      ]);
      expect(result).toEqual({
        published: 0,
        skipped: 2,
        subprofile: { id: PERSONA_ID },
      });
      expect(subprofilesService.insertItemsAtTop).not.toHaveBeenCalled();
    });

    it('downloads at most MAX_ART_DOWNLOADS_PER_PUBLISH distinct images', async () => {
      entries.find.mockResolvedValue(
        Array.from({ length: 30 }, (_, index) =>
          makeEntry(`e${index}`, null, {
            remoteImageUrl: `https://cdn.example/${index}.jpg`,
          }),
        ),
      );
      await service.publishEntries(
        makeFeed(),
        OWNER_ID,
        Array.from({ length: 30 }, (_, index) => `e${index}`),
      );
      expect(fetcher.fetchImage).toHaveBeenCalledTimes(
        MAX_ART_DOWNLOADS_PER_PUBLISH,
      );
    });

    it('falls back to the show art when an episode image cannot be stored', async () => {
      entries.find.mockResolvedValue([
        makeEntry('a', null, { remoteImageUrl: 'https://cdn.example/a.jpg' }),
      ]);
      fetcher.fetchImage.mockResolvedValue(null);
      let captured: TopInsertCandidate<string>[] = [];
      subprofilesService.insertItemsAtTop.mockImplementationOnce(
        async (
          _u: string,
          _s: string,
          _sec: SubprofileSection,
          options: {
            selectCandidates: (
              m: EntityManager,
            ) => Promise<TopInsertCandidate<string>[]>;
          },
        ) => {
          captured = await options.selectCandidates(
            txManager as unknown as EntityManager,
          );
          return { inserted: 0, subprofile: {} };
        },
      );
      await service.publishEntries(makeFeed(), OWNER_ID, ['a']);
      expect(captured[0]?.fields.imageUrl).toBe(SHOW_ART_KEY);
    });
  });

  describe('syncFeed', () => {
    it('records a failure with exponential backoff and the error code', async () => {
      fetcher.fetchFeed.mockRejectedValue(new FeedFetchError('timeout'));
      await service.syncFeed(
        makeFeed({ consecutiveFailures: 2 }),
        { kind: 'scheduled' },
        NOW,
      );
      expect(feeds.update).toHaveBeenCalledWith(
        { id: FEED_ID },
        {
          lastAttemptAt: NOW,
          consecutiveFailures: 3,
          lastError: 'timeout',
          nextCheckAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
        },
      );
      expect(insertedValues).toEqual([]);
    });

    it('records a document that is not RSS as not_a_feed', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: '<html><body>nope</body></html>',
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });
      await service.syncFeed(makeFeed(), { kind: 'scheduled' }, NOW);
      expect(feeds.update).toHaveBeenCalledWith(
        { id: FEED_ID },
        expect.objectContaining({
          lastError: 'not_a_feed',
          consecutiveFailures: 1,
        }),
      );
    });

    it('sends the stored validators and treats a 304 as a quiet success', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: true,
        finalUrl: 'https://feeds.example/show',
      });
      await service.syncFeed(
        makeFeed({ consecutiveFailures: 4, lastError: 'timeout' }),
        { kind: 'scheduled' },
        NOW,
      );
      expect(fetcher.fetchFeed).toHaveBeenCalledWith(
        'https://feeds.example/show',
        { etag: '"v1"', lastModified: null },
      );
      expect(feeds.update).toHaveBeenCalledWith(
        { id: FEED_ID },
        {
          lastAttemptAt: NOW,
          lastSyncedAt: NOW,
          consecutiveFailures: 0,
          lastError: null,
          nextCheckAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000),
        },
      );
      expect(insertedValues).toEqual([]);
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('stages only unseen guids as pending and tells every member', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss(
          item('known', 'Mon, 01 Jan 2024 00:00:00 GMT') +
            item('fresh-1', 'Tue, 02 Jan 2024 00:00:00 GMT') +
            item('fresh-2', 'Wed, 03 Jan 2024 00:00:00 GMT'),
        ),
        finalUrl: 'https://feeds.example/show',
        etag: '"v2"',
        lastModified: null,
      });
      entries.manager.find.mockResolvedValue([{ guid: 'known' }]);
      entries.count.mockResolvedValue(2);

      const outcome = await service.syncFeed(
        makeFeed(),
        { kind: 'scheduled' },
        NOW,
      );

      expect(insertedValues.map((row) => [row.guid, row.status])).toEqual([
        ['fresh-2', 'pending'],
        ['fresh-1', 'pending'],
      ]);
      expect(outcome).toEqual({ newEntryCount: 2, newPendingCount: 2 });
      expect(feeds.update).toHaveBeenCalledWith(
        { id: FEED_ID },
        expect.objectContaining({ etag: '"v2"', consecutiveFailures: 0 }),
      );
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        [OWNER_ID, CO_OWNER_ID],
        NotificationType.PersonaImportReady,
        {
          subprofileId: PERSONA_ID,
          subprofileName: 'Night Radio',
          subprofileSlugOrHandle: 'nightradio',
          feedId: FEED_ID,
          feedTitle: 'The Show',
          newItemCount: 2,
        },
      );
      expect(subprofilesService.insertItemsAtTop).not.toHaveBeenCalled();
    });

    it('never rewrites an episode it has already recorded', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss(item('known', 'Mon, 01 Jan 2024 00:00:00 GMT')),
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });
      entries.manager.find.mockResolvedValue([{ guid: 'known' }]);
      await service.syncFeed(makeFeed(), { kind: 'scheduled' }, NOW);
      expect(insertedValues).toEqual([]);
      expect(entries.update).not.toHaveBeenCalled();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('auto-publishes as the creator when they may, without a bell', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss(item('fresh', 'Tue, 02 Jan 2024 00:00:00 GMT')),
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });
      feeds.findOne.mockResolvedValue(makeFeed({ autoPublish: true }));
      entries.find.mockResolvedValue([makeEntry('new-fresh', null)]);
      entries.count.mockResolvedValue(0);

      await service.syncFeed(
        makeFeed({ autoPublish: true }),
        { kind: 'scheduled' },
        NOW,
      );

      expect(subprofilesService.insertItemsAtTop).toHaveBeenCalledWith(
        OWNER_ID,
        PERSONA_ID,
        SubprofileSection.Episodes,
        expect.anything(),
      );
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it.each([
      ['has left the persona', () => members.exists.mockResolvedValue(false)],
      [
        'is suspended',
        () =>
          users.findOne.mockResolvedValue({
            id: OWNER_ID,
            status: UserStatus.Suspended,
            restricted: false,
            restrictedUntil: null,
          }),
      ],
      [
        'is restricted',
        () =>
          users.findOne.mockResolvedValue({
            id: OWNER_ID,
            status: UserStatus.Active,
            restricted: true,
            restrictedUntil: new Date(NOW.getTime() + 1e9),
          }),
      ],
    ])(
      'leaves new episodes pending (and rings the bell) when the creator %s',
      async (_label, stage) => {
        stage();
        fetcher.fetchFeed.mockResolvedValue({
          notModified: false,
          xml: rss(item('fresh', 'Tue, 02 Jan 2024 00:00:00 GMT')),
          finalUrl: 'https://feeds.example/show',
          etag: null,
          lastModified: null,
        });
        feeds.findOne.mockResolvedValue(makeFeed({ autoPublish: true }));
        entries.count.mockResolvedValue(1);
        await service.syncFeed(
          makeFeed({ autoPublish: true }),
          { kind: 'scheduled' },
          NOW,
        );
        expect(subprofilesService.insertItemsAtTop).not.toHaveBeenCalled();
        expect(notifications.createForRecipients).toHaveBeenCalledWith(
          expect.any(Array),
          NotificationType.PersonaImportReady,
          expect.objectContaining({ newItemCount: 1 }),
        );
      },
    );

    it('keeps episodes pending when auto-publish fails (e.g. a full section)', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss(item('fresh', 'Tue, 02 Jan 2024 00:00:00 GMT')),
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });
      feeds.findOne.mockResolvedValue(makeFeed({ autoPublish: true }));
      entries.find.mockResolvedValue([makeEntry('new-fresh', null)]);
      items.count.mockResolvedValue(100);
      entries.count.mockResolvedValue(1);
      await expect(
        service.syncFeed(
          makeFeed({ autoPublish: true }),
          { kind: 'scheduled' },
          NOW,
        ),
      ).resolves.toEqual({ newEntryCount: 1, newPendingCount: 1 });
      expect(notifications.createForRecipients).toHaveBeenCalled();
    });

    it('does not ring the bell for a manual sync', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss(item('fresh', 'Tue, 02 Jan 2024 00:00:00 GMT')),
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });
      entries.count.mockResolvedValue(1);
      await service.syncFeed(
        makeFeed(),
        { kind: 'manual', userId: CO_OWNER_ID },
        NOW,
      );
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('stores missing show art as the acting member', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss('', '<itunes:image href="https://cdn.example/show.jpg"/>'),
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });
      await service.syncFeed(
        makeFeed({ imageKey: null }),
        { kind: 'manual', userId: CO_OWNER_ID },
        NOW,
      );
      expect(fetcher.fetchImage).toHaveBeenCalledWith(
        'https://cdn.example/show.jpg',
      );
      expect(storage.putServerObject).toHaveBeenCalledWith(
        'work-image',
        CO_OWNER_ID,
        expect.any(Uint8Array),
        'image/png',
      );
      // T17: written under the persona lock, after the in-lock re-check.
      expect(txManager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: PERSONA_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(personaImageKeys.rehomeForPersonaWrite).toHaveBeenCalledWith(
        txManager,
        PERSONA_ID,
        [expect.stringMatching(new RegExp(`^work/${CO_OWNER_ID}/`))],
      );
      const showArtUpdate = txManager.update.mock.calls.find(
        ([entity]) => entity === SubprofileFeed,
      ) as [unknown, unknown, { imageKey?: string }] | undefined;
      expect(showArtUpdate?.[2].imageKey).toMatch(
        new RegExp(`^work/${CO_OWNER_ID}/`),
      );
    });

    // T17: the persona went unlinked while the art downloaded, so the
    // in-lock re-check copies it to a persona-scoped key before the write.
    it('writes the re-homed show art when the persona went unlinked meanwhile', async () => {
      const personaKey =
        'persona/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888.png';
      personaImageKeys.rehomeForPersonaWrite.mockImplementation(
        (_manager: unknown, _id: string, [storedKey]: string[]) =>
          Promise.resolve(new Map([[storedKey, personaKey]])),
      );
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss('', '<itunes:image href="https://cdn.example/show.jpg"/>'),
        finalUrl: 'https://feeds.example/show',
        etag: null,
        lastModified: null,
      });

      await service.syncFeed(
        makeFeed({ imageKey: null }),
        { kind: 'manual', userId: CO_OWNER_ID },
        NOW,
      );

      const showArtUpdate = txManager.update.mock.calls.find(
        ([entity]) => entity === SubprofileFeed,
      ) as [unknown, unknown, { imageKey?: string }] | undefined;
      expect(showArtUpdate?.[2].imageKey).toBe(personaKey);
    });
  });

  describe('connect', () => {
    const feedXml = rss(
      item('a', 'Mon, 01 Jan 2024 00:00:00 GMT') +
        item('b', 'Tue, 02 Jan 2024 00:00:00 GMT'),
      '<itunes:image href="https://cdn.example/show.jpg"/>',
    );

    beforeEach(() => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: feedXml,
        finalUrl: 'https://final.example/show',
        etag: '"v1"',
        lastModified: null,
      });
      feeds.findOne.mockResolvedValue(
        makeFeed({ feedUrl: 'https://final.example/show' }),
      );
    });

    it('records the back catalogue as dismissed for backfill "none"', async () => {
      await service.connect(OWNER_ID, PERSONA_ID, {
        url: 'feeds.example/show',
        section: 'projects',
        backfill: 'none',
      });
      expect(fetcher.fetchFeed).toHaveBeenCalledWith(
        'https://feeds.example/show',
        null,
      );
      const [, created] = txManager.create.mock.calls.find(
        ([entity]) => entity === SubprofileFeed,
      ) as [unknown, Record<string, unknown>];
      expect(created).toEqual(
        expect.objectContaining({
          subprofileId: PERSONA_ID,
          createdById: OWNER_ID,
          feedUrl: 'https://final.example/show',
          section: SubprofileSection.Projects,
          autoPublish: false,
          etag: '"v1"',
        }),
      );
      expect(created.imageKey).toMatch(new RegExp(`^work/${OWNER_ID}/`));
      expect(insertedValues.map((row) => row.status)).toEqual([
        'dismissed',
        'dismissed',
      ]);
    });

    it('stages the back catalogue as pending for backfill "all"', async () => {
      await service.connect(OWNER_ID, PERSONA_ID, {
        url: 'https://feeds.example/show',
        section: 'projects',
        autoPublish: true,
        backfill: 'all',
      });
      expect(insertedValues.map((row) => [row.guid, row.status])).toEqual([
        ['b', 'pending'],
        ['a', 'pending'],
      ]);
      // The back catalogue waits for review even on an auto-publish feed.
      expect(subprofilesService.insertItemsAtTop).not.toHaveBeenCalled();
    });

    it('answers 422 FEED_LIMIT at three feeds', async () => {
      feeds.manager.count.mockResolvedValue(3);
      const error: unknown = await service
        .connect(OWNER_ID, PERSONA_ID, {
          url: 'https://feeds.example/show',
          section: 'projects',
          backfill: 'all',
        })
        .catch((caught: unknown) => caught);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'FEED_LIMIT' }),
      );
      expect(fetcher.fetchFeed).not.toHaveBeenCalled();
    });

    it('answers 409 FEED_ALREADY_CONNECTED for the resolved URL', async () => {
      feeds.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const error: unknown = await service
        .connect(OWNER_ID, PERSONA_ID, {
          url: 'https://feeds.example/show',
          section: 'projects',
          backfill: 'all',
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'FEED_ALREADY_CONNECTED' }),
      );
    });

    it('answers 422 with the feed error code', async () => {
      fetcher.fetchFeed.mockRejectedValue(new FeedFetchError('too_large'));
      const error: unknown = await service
        .connect(OWNER_ID, PERSONA_ID, {
          url: 'https://feeds.example/show',
          section: 'projects',
          backfill: 'all',
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'too_large' }),
      );
    });

    it.each(['gallery', 'links', 'discography', 'nope'])(
      'refuses the %s section with a 400',
      async (section) => {
        await expect(
          service.connect(OWNER_ID, PERSONA_ID, {
            url: 'https://feeds.example/show',
            section,
            backfill: 'all',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe('syncNow', () => {
    it('answers 429 when the feed was checked under five minutes ago', async () => {
      feeds.findOne.mockResolvedValue(
        makeFeed({ lastAttemptAt: new Date(Date.now() - 60_000) }),
      );
      feeds.createQueryBuilder.mockImplementation(() => {
        const chain = {
          update: () => chain,
          set: () => chain,
          where: () => chain,
          andWhere: () => chain,
          execute: () => Promise.resolve({ affected: 0 }),
        };
        return chain;
      });
      const error: unknown = await service
        .syncNow(OWNER_ID, PERSONA_ID, FEED_ID)
        .catch((caught: unknown) => caught);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(fetcher.fetchFeed).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('shows the newest five episodes with no remote art, and whether it is connected', async () => {
      fetcher.fetchFeed.mockResolvedValue({
        notModified: false,
        xml: rss(
          Array.from({ length: 7 }, (_, index) =>
            item(
              `g${index}`,
              new Date(Date.UTC(2024, 0, index + 1)).toUTCString(),
              `<itunes:image href="https://cdn.example/${index}.jpg"/>`,
            ),
          ).join(''),
          '<itunes:image href="https://cdn.example/show.jpg"/>',
        ),
        finalUrl: 'https://final.example/show',
        etag: null,
        lastModified: null,
      });
      feeds.exists.mockResolvedValue(true);
      const preview = await service.preview(
        OWNER_ID,
        'https://feeds.example/show',
        PERSONA_ID,
      );
      expect(subprofilesService.getOwned).toHaveBeenCalledWith(
        OWNER_ID,
        PERSONA_ID,
      );
      expect(preview.feedUrl).toBe('https://final.example/show');
      expect(preview.title).toBe('The Show');
      expect(preview.episodeCount).toBe(7);
      expect(preview.latest.map((episode) => episode.guid)).toEqual([
        'g6',
        'g5',
        'g4',
        'g3',
        'g2',
      ]);
      expect(preview.alreadyConnected).toBe(true);
      expect(JSON.stringify(preview)).not.toContain('cdn.example');
    });
  });

  describe('feed DTOs', () => {
    it('counts pending/published entries and resolves our art key, never a remote URL', async () => {
      feeds.find.mockResolvedValue([makeFeed({ consecutiveFailures: 3 })]);
      entries.createQueryBuilder.mockImplementation(() =>
        countsQuery([
          { feedId: FEED_ID, status: 'pending', count: 4 },
          { feedId: FEED_ID, status: 'published', count: 9 },
        ]),
      );
      const [dto] = await service.list(OWNER_ID, PERSONA_ID);
      expect(dto).toEqual(
        expect.objectContaining({
          id: FEED_ID,
          status: 'failing',
          pendingCount: 4,
          publishedCount: 9,
          imageUrl: `https://api.test/files/${SHOW_ART_KEY}`,
        }),
      );
    });
  });
});
