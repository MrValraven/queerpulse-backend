import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { StorageService } from '../storage/storage.service';
import {
  AdminStudioScenesService,
  normalizeSceneBlurb,
} from './admin-studio-scenes.service';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { encodeStudioCursor } from './studio-cursor';
import { openUpcomingEventSql } from './studio-discovery-sql';
import { StudioReleaseCard } from './studio-response';
import { toStudioSceneCard } from './studio-scene-response';

const STAFF_ID = 'e9000000-0000-4000-8000-000000000001';
const OTHER_STAFF_ID = 'e9000000-0000-4000-8000-000000000002';
const SCENE_ID = 'e9000000-0000-4000-8000-000000000011';
const SECOND_SCENE = 'e9000000-0000-4000-8000-000000000012';
const EVENT_ID = 'e9000000-0000-4000-8000-000000000021';
const RELEASE_ID = 'e9000000-0000-4000-8000-000000000031';
const OWN_COVER = `work/${STAFF_ID}/f0000000-0000-4000-8000-000000000001.jpg`;
const OTHER_STAFF_COVER = `work/${OTHER_STAFF_ID}/f0000000-0000-4000-8000-000000000002.jpg`;
/** The scene-scoped copies the storage mock mints: random segments only. */
const SCENE_COVER = `studio-scene/f1000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002.jpg`;
const NEXT_SCENE_COVER = `studio-scene/f1000000-0000-4000-8000-000000000003/f1000000-0000-4000-8000-000000000004.jpg`;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const sceneRow = {
  id: SCENE_ID,
  slug: 'lisbon-ballroom',
  name: 'Lisbon ballroom',
  city: 'Lisbon',
  blurb: null,
  cover_key: null,
  status: 'active',
  position: 1,
  release_count: 3,
  pinned_event_count: 1,
  created_at: new Date('2026-10-13T09:00:00.000Z'),
  updated_at: new Date('2026-10-13T09:00:00.000Z'),
};

/** The pin read answers one row whose `is_pinnable` the helper computes. */
function pinReadAnswers(
  eventRows: { id: string; is_pinnable: boolean }[],
): (sql: string) => Promise<unknown[]> {
  return (sql: string) =>
    Promise.resolve(sql.includes('AS "is_pinnable"') ? eventRows : []);
}

describe('normalizeSceneBlurb', () => {
  it('trims and stores an empty blurb as null', () => {
    expect(normalizeSceneBlurb('  Vogue nights ')).toBe('Vogue nights');
    expect(normalizeSceneBlurb('  ')).toBeNull();
    expect(normalizeSceneBlurb(null)).toBeNull();
  });
});

describe('AdminStudioScenesService', () => {
  let query: jest.Mock;
  let manager: {
    query: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
  };
  let scenes: { findOne: jest.Mock; update: jest.Mock };
  let catalog: { cardsByReleaseId: jest.Mock };
  let storage: {
    copyObjectToStudioSceneScope: jest.Mock;
    deleteObjectByKey: jest.Mock;
  };
  let service: AdminStudioScenesService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([sceneRow]);
    manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('MAX("position")') ? [{ position: 4 }] : [],
        ),
      ),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) => Promise.resolve({ ...row, id: SCENE_ID })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockResolvedValue({
        id: SCENE_ID,
        status: StudioSceneState.Archived,
      }),
    };
    scenes = {
      findOne: jest.fn().mockResolvedValue({
        id: SCENE_ID,
        slug: 'lisbon-ballroom',
        coverKey: OTHER_STAFF_COVER,
        status: StudioSceneState.Active,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    catalog = {
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(
            releaseIds.map((releaseId) => [
              releaseId,
              { id: releaseId } as StudioReleaseCard,
            ]),
          ),
        ),
      ),
    };
    const dataSource = {
      query,
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      getRepository: jest.fn(() => scenes),
    };
    storage = {
      copyObjectToStudioSceneScope: jest.fn().mockResolvedValue(SCENE_COVER),
      deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
    };
    service = new AdminStudioScenesService(
      dataSource as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
      storage as unknown as StorageService,
    );
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('create', () => {
    it('builds the slug from the name, takes the first free one and appends the scene', async () => {
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('= ANY($1::text[])')
            ? [{ slug: 'porto-nights' }]
            : sql.includes('MAX("position")')
              ? [{ position: 4 }]
              : [],
        ),
      );

      await service.create(STAFF_ID, {
        name: 'Porto nights',
        city: 'Porto',
        blurb: '   ',
        coverKey: OWN_COVER,
      });

      expect(manager.query.mock.calls[0]?.[0]).toBe(
        'LOCK TABLE "studio_scenes" IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(manager.create).toHaveBeenCalledWith(StudioScene, {
        slug: 'porto-nights-2',
        name: 'Porto nights',
        city: 'Porto',
        blurb: null,
        coverKey: SCENE_COVER,
        status: StudioSceneState.Active,
        position: 4,
        createdById: STAFF_ID,
      });
      expect(storage.copyObjectToStudioSceneScope).toHaveBeenCalledWith(
        OWN_COVER,
      );
    });

    it('stores a scene-scoped copy of the cover whose key and served URL carry no user id', async () => {
      setImageUrlBase('https://api.example.test');
      query.mockResolvedValue([{ ...sceneRow, cover_key: SCENE_COVER }]);

      const created = await service.create(STAFF_ID, {
        name: 'Porto nights',
        city: 'Porto',
        coverKey: OWN_COVER,
      });

      const [, createdRow] = manager.create.mock.calls[0] as [
        unknown,
        { coverKey: string },
      ];
      const storedCoverKey = createdRow.coverKey;
      expect(storedCoverKey).toMatch(/^studio-scene\//);
      expect(storedCoverKey).not.toContain(STAFF_ID);
      expect(created.coverUrl).toBe(
        `https://api.example.test/files/${SCENE_COVER}`,
      );
      const memberCard = toStudioSceneCard({
        id: SCENE_ID,
        slug: 'porto-nights',
        name: 'Porto nights',
        city: 'Porto',
        coverKey: storedCoverKey,
      });
      expect(memberCard.coverUrl).not.toContain(STAFF_ID);
      expect(memberCard.coverUrl).toBe(
        `https://api.example.test/files/${SCENE_COVER}`,
      );
    });

    it('refuses an explicit slug another scene holds', async () => {
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('"slug" = $1') ? [{ found: 1 }] : []),
      );
      expect(
        await codeOf(
          service.create(STAFF_ID, {
            name: 'Porto',
            city: 'Porto',
            slug: 'lisbon-ballroom',
          }),
        ),
      ).toBe('studio_scene_slug_taken');
    });

    it('answers a lost slug race with the slug code', async () => {
      manager.save.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_studio_scenes_slug',
      });
      expect(
        await codeOf(
          service.create(STAFF_ID, { name: 'Porto', city: 'Porto' }),
        ),
      ).toBe('studio_scene_slug_taken');
    });

    it("refuses another member's upload as a new cover", async () => {
      await expect(
        service.create(STAFF_ID, {
          name: 'Porto',
          city: 'Porto',
          coverKey: OTHER_STAFF_COVER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('accepts the stored cover another staff member uploaded, stores it as a scene-scoped copy and stores the other fields', async () => {
      await service.update(STAFF_ID, SCENE_ID, {
        name: 'Lisbon ballroom nights',
        coverKey: OTHER_STAFF_COVER,
        blurb: '',
      });
      expect(manager.update).toHaveBeenCalledWith(
        StudioScene,
        { id: SCENE_ID },
        {
          name: 'Lisbon ballroom nights',
          coverKey: SCENE_COVER,
          blurb: null,
        },
      );
    });

    it('keeps its own scene-scoped cover as sent, with no copy and no delete', async () => {
      scenes.findOne.mockResolvedValue({
        id: SCENE_ID,
        slug: 'lisbon-ballroom',
        coverKey: SCENE_COVER,
        status: StudioSceneState.Active,
      });
      await service.update(STAFF_ID, SCENE_ID, { coverKey: SCENE_COVER });
      expect(manager.update).toHaveBeenCalledWith(
        StudioScene,
        { id: SCENE_ID },
        { coverKey: SCENE_COVER },
      );
      expect(storage.copyObjectToStudioSceneScope).not.toHaveBeenCalled();
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('copies a new cover, then deletes the replaced copy after the write', async () => {
      scenes.findOne.mockResolvedValue({
        id: SCENE_ID,
        slug: 'lisbon-ballroom',
        coverKey: SCENE_COVER,
        status: StudioSceneState.Active,
      });
      storage.copyObjectToStudioSceneScope.mockResolvedValue(NEXT_SCENE_COVER);

      await service.update(STAFF_ID, SCENE_ID, { coverKey: OWN_COVER });

      expect(manager.update).toHaveBeenCalledWith(
        StudioScene,
        { id: SCENE_ID },
        { coverKey: NEXT_SCENE_COVER },
      );
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(SCENE_COVER);
      const writeOrder = manager.update.mock.invocationCallOrder[0] ?? 0;
      const deleteOrder =
        storage.deleteObjectByKey.mock.invocationCallOrder[0] ?? 0;
      expect(writeOrder).toBeLessThan(deleteOrder);
    });

    it("refuses another scene's scene-scoped cover", async () => {
      await expect(
        service.update(STAFF_ID, SCENE_ID, { coverKey: NEXT_SCENE_COVER }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('refuses a slug another scene holds and leaves the scene as it was', async () => {
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('"slug" = $1') ? [{ found: 1 }] : []),
      );
      expect(
        await codeOf(service.update(STAFF_ID, SCENE_ID, { slug: 'porto' })),
      ).toBe('studio_scene_slug_taken');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown scene', async () => {
      scenes.findOne.mockResolvedValue(null);
      await expect(
        service.update(STAFF_ID, SCENE_ID, { name: 'Porto' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('archive and restore', () => {
    it('archives a scene and keeps its releases and pins', async () => {
      await service.archive(SCENE_ID);
      expect(scenes.update).toHaveBeenCalledTimes(1);
      expect(scenes.update).toHaveBeenCalledWith(
        { id: SCENE_ID },
        { status: StudioSceneState.Archived },
      );
      // The status is the only write: the one raw statement is the read of
      // the scene the route answers with, and no transaction runs, so no
      // release link or pin is touched.
      expect(query.mock.calls).toEqual([
        [expect.stringMatching(/^SELECT "scene"\."id"/), [SCENE_ID, null]],
      ]);
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('restores a scene at the last active position', async () => {
      await service.restore(SCENE_ID);
      expect(manager.update).toHaveBeenCalledWith(
        StudioScene,
        { id: SCENE_ID },
        { status: StudioSceneState.Active, position: 4 },
      );
    });
  });

  describe('reorder', () => {
    it('writes 1..n over every active scene in one statement', async () => {
      manager.find.mockResolvedValue([{ id: SCENE_ID }, { id: SECOND_SCENE }]);
      await service.reorder([SECOND_SCENE, SCENE_ID]);
      const reorderCall = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes('unnest'),
      ) as [string, unknown[]];
      expect(reorderCall[1]).toEqual([
        [SECOND_SCENE, SCENE_ID],
        [1, 2],
      ]);
    });

    it('answers a mismatch when an active scene is missing or repeated', async () => {
      manager.find.mockResolvedValue([{ id: SCENE_ID }, { id: SECOND_SCENE }]);
      expect(await codeOf(service.reorder([SCENE_ID]))).toBe(
        'studio_scene_order_mismatch',
      );
      expect(await codeOf(service.reorder([SCENE_ID, SCENE_ID]))).toBe(
        'studio_scene_order_mismatch',
      );
    });
  });

  describe('events', () => {
    it('pins an upcoming open event idempotently', async () => {
      query.mockImplementation(
        pinReadAnswers([{ id: EVENT_ID, is_pinnable: true }]),
      );
      await service.pinEvent(STAFF_ID, SCENE_ID, EVENT_ID);
      const [sql, parameters] = query.mock.calls.find(([statement]) =>
        String(statement).includes('INSERT INTO "studio_scene_events"'),
      ) as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT ("scene_id", "event_id") DO NOTHING');
      expect(parameters).toEqual([SCENE_ID, EVENT_ID, STAFF_ID]);
    });

    it('decides a pin with the open upcoming event rule the search lists by', async () => {
      query.mockImplementation(
        pinReadAnswers([{ id: EVENT_ID, is_pinnable: true }]),
      );
      await service.pinEvent(STAFF_ID, SCENE_ID, EVENT_ID);
      const [sql, parameters] = query.mock.calls.find(([statement]) =>
        String(statement).includes('AS "is_pinnable"'),
      ) as [string, unknown[]];
      expect(sql).toContain(openUpcomingEventSql('event'));
      expect(parameters).toEqual([EVENT_ID]);
    });

    it('answers 404 for an unknown event and 422 for one the rule turns down', async () => {
      query.mockImplementation(pinReadAnswers([]));
      await expect(
        service.pinEvent(STAFF_ID, SCENE_ID, EVENT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      // A draft, a started event, a narrower audience or a moderated event
      // all read `is_pinnable` false.
      query.mockImplementation(
        pinReadAnswers([{ id: EVENT_ID, is_pinnable: false }]),
      );
      expect(await codeOf(service.pinEvent(STAFF_ID, SCENE_ID, EVENT_ID))).toBe(
        'studio_scene_event_not_pinnable',
      );
      expect(
        query.mock.calls.some(([statement]) =>
          String(statement).includes('INSERT INTO "studio_scene_events"'),
        ),
      ).toBe(false);
    });

    it('answers studio_scene_event_not_pinnable for an event a space hosts', async () => {
      // The space rule lives in the helper the pin read applies: a host
      // community with a parent turns `is_pinnable` false.
      const openUpcomingPredicate = openUpcomingEventSql('event');
      expect(openUpcomingPredicate).toContain(
        '"event_space"."parent_id" IS NOT NULL',
      );
      query.mockImplementation(
        pinReadAnswers([{ id: EVENT_ID, is_pinnable: false }]),
      );
      expect(await codeOf(service.pinEvent(STAFF_ID, SCENE_ID, EVENT_ID))).toBe(
        'studio_scene_event_not_pinnable',
      );
      const [sql] = query.mock.calls.find(([statement]) =>
        String(statement).includes('AS "is_pinnable"'),
      ) as [string, unknown[]];
      expect(sql).toContain(openUpcomingPredicate);
    });

    it('answers 404 for an unknown scene before reading the event', async () => {
      scenes.findOne.mockResolvedValue(null);
      await expect(
        service.pinEvent(STAFF_ID, SCENE_ID, EVENT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(query).not.toHaveBeenCalled();
    });

    it('searches upcoming open events by folded title, soonest first, moderation applied', async () => {
      query.mockResolvedValue([]);
      await service.searchEvents('  Ballroom ');
      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(openUpcomingEventSql('event'));
      expect(sql).toContain('"event"."start_at" > now()');
      expect(sql).toContain(`"event"."visibility" IN ('public', 'members')`);
      expect(sql).toContain('content_moderation');
      expect(sql).toContain('ORDER BY "event"."start_at" ASC');
      expect(parameters).toEqual(['%Ballroom%', 20]);
    });
  });

  describe('releases', () => {
    it('pages every release of the scene on created_at in milliseconds, 24 at a time', async () => {
      const rows = Array.from({ length: 25 }, (_unused, index) => ({
        id: `e9000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
        status: 'draft',
        created_at_ms: new Date(Date.UTC(2026, 9, 13, 9, 0, 59 - index)),
      }));
      query.mockResolvedValue(rows);

      const page = await service.listReleases(SCENE_ID, undefined);

      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(
        `date_trunc('milliseconds', "release"."created_at")`,
      );
      expect(parameters).toEqual([SCENE_ID, null, null, 25]);
      expect(page.items).toHaveLength(24);
      expect(page.items[0]).toEqual({ id: rows[0]!.id, status: 'draft' });
      expect(page.pageInfo).toEqual({
        hasMore: true,
        nextCursor: encodeStudioCursor({
          publishedAt: rows[23]!.created_at_ms,
          id: rows[23]!.id,
        }),
      });
    });

    it('removes a release from the scene and answers 404 for one outside it', async () => {
      query.mockResolvedValueOnce([{ id: RELEASE_ID }]);
      await service.removeRelease(SCENE_ID, RELEASE_ID);
      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('SET "scene_id" = NULL');
      expect(sql).toContain('"scene_id" = $2');
      expect(parameters).toEqual([RELEASE_ID, SCENE_ID]);

      query.mockResolvedValueOnce([]);
      await expect(
        service.removeRelease(SCENE_ID, RELEASE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
