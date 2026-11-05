import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PersonaWallPick } from './entities/persona-wall-pick.entity';
import { PersonaWallSettings } from './entities/persona-wall-settings.entity';
import {
  type Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  CLOSE_WALL_POSITION_GAP_SQL,
  DEFER_WALL_POSITION_SQL,
  LOCK_WALL_PICKS_SQL,
  PersonaWallService,
  REORDER_WALL_PICKS_SQL,
  UPSERT_WALL_SETTINGS_SQL,
} from './persona-wall.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';
import type { SubprofileCardView } from './subprofile-response';

const ADMIN_ID = 'd7300000-0000-4000-8000-000000000001';
const FIRST_PERSONA_ID = 'd7300000-0000-4000-8000-000000000011';
const SECOND_PERSONA_ID = 'd7300000-0000-4000-8000-000000000012';
const THIRD_PERSONA_ID = 'd7300000-0000-4000-8000-000000000013';
const FOURTH_PERSONA_ID = 'd7300000-0000-4000-8000-000000000014';
const FIRST_PICK_ID = 'd7300000-0000-4000-8000-000000000021';
const SECOND_PICK_ID = 'd7300000-0000-4000-8000-000000000022';
const THIRD_PICK_ID = 'd7300000-0000-4000-8000-000000000023';
const FOURTH_PICK_ID = 'd7300000-0000-4000-8000-000000000024';
const FOREIGN_PICK_ID = 'd7300000-0000-4000-8000-000000000029';
// Well-formed storage keys: `toImageUrl` drops anything that does not parse
// as one.
const AVATAR_KEY =
  'persona/d7300000-0000-4000-8000-000000000011/d7300000-0000-4000-8000-000000000031.jpg';
const SECOND_AVATAR_KEY =
  'persona/d7300000-0000-4000-8000-000000000012/d7300000-0000-4000-8000-000000000032.jpg';
const THIRD_AVATAR_KEY =
  'persona/d7300000-0000-4000-8000-000000000013/d7300000-0000-4000-8000-000000000033.jpg';
const API_BASE_URL = 'https://api.example.test';

interface RefusalOutcome {
  code?: string;
  status?: number;
  publicState?: string;
}

async function codeOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as {
      code?: string;
      publicState?: string;
    };
    return {
      code: body.code,
      status: httpError.getStatus(),
      publicState: body.publicState,
    };
  }
}

/** The global call order of one call of a mock. Throws when that call never
 *  happened, so an order assertion can not pass on a missing call. */
function callOrderOf(mockFunction: jest.Mock, callIndex = 0): number {
  const callOrder = mockFunction.mock.invocationCallOrder[callIndex];
  if (callOrder === undefined) {
    throw new Error(`Call ${callIndex} of the mock never happened`);
  }
  return callOrder;
}

function buildPersona(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: FIRST_PERSONA_ID,
    handle: 'ana-poet',
    displayName: 'Ana Poet',
    kind: 'writer',
    avatarUrl: AVATAR_KEY,
    coverUrl: null,
    accent: 'coral',
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    removedAt: null,
    ...overrides,
  } as Subprofile;
}

function buildPick(
  id: string,
  subprofileId: string,
  position: number,
): PersonaWallPick {
  return { id, subprofileId, position } as PersonaWallPick;
}

function buildCard(id: string): SubprofileCardView {
  return { id, displayName: `Card ${id}` } as unknown as SubprofileCardView;
}

describe('PersonaWallService', () => {
  beforeAll(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterAll(() => {
    resetImageUrlBaseForTesting();
  });

  let manager: {
    query: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    maximum: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let publicRead: { listWallCards: jest.Mock; searchWallPersonas: jest.Mock };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let service: PersonaWallService;
  let storedPicks: PersonaWallPick[];
  let storedSettings: { id: number; fillOrder: string } | null;
  let storedPersonas: Subprofile[];
  let personaForAdd: Subprofile | null;

  beforeEach(() => {
    storedPicks = [];
    storedSettings = null;
    storedPersonas = [];
    personaForAdd = buildPersona();
    manager = {
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn((entity: unknown) => {
        if (entity === PersonaWallPick) {
          return Promise.resolve(storedPicks);
        }
        return Promise.resolve(storedPersonas);
      }),
      findOne: jest.fn((entity: unknown) => {
        if (entity === PersonaWallSettings) {
          return Promise.resolve(storedSettings);
        }
        if (entity === PersonaWallPick) {
          return Promise.resolve(null);
        }
        return Promise.resolve(personaForAdd);
      }),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      maximum: jest.fn().mockResolvedValue(null),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ ...row, id: FIRST_PICK_ID }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      manager,
    };
    publicRead = {
      listWallCards: jest.fn().mockResolvedValue([]),
      searchWallPersonas: jest.fn().mockResolvedValue([]),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    service = new PersonaWallService(
      dataSource as unknown as DataSource,
      publicRead as unknown as SubprofilePublicReadService,
      contentModeration as unknown as ContentModerationService,
      mediaCropService as unknown as MediaCropService,
    );
  });

  describe('publicWall', () => {
    it('reads the wall for the viewer with the stored order and the Lisbon day', async () => {
      storedSettings = { id: 1, fillOrder: 'followed' };
      storedPicks = [
        buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 1),
        buildPick(SECOND_PICK_ID, SECOND_PERSONA_ID, 2),
      ];
      const card = buildCard(FIRST_PERSONA_ID);
      publicRead.listWallCards.mockResolvedValue([
        { card, wallSource: 'picked' },
      ]);

      const wall = await service.publicWall(
        'viewer-1',
        new Date('2026-07-01T23:30:00Z'),
      );

      expect(publicRead.listWallCards).toHaveBeenCalledWith({
        pickedSubprofileIds: [FIRST_PERSONA_ID, SECOND_PERSONA_ID],
        fillOrder: 'followed',
        viewerId: 'viewer-1',
        wallDay: '2026-07-02',
      });
      expect(wall).toEqual({ items: [card] });
      expect(wall.items[0]).not.toHaveProperty('wallSource');
      expect(manager.find).toHaveBeenCalledWith(PersonaWallPick, {
        select: { id: true, subprofileId: true, position: true },
        order: { position: 'ASC' },
      });
    });

    it('reads a missing settings row as endorsed', async () => {
      await service.publicWall('viewer-1', new Date('2026-07-01T10:00:00Z'));

      expect(publicRead.listWallCards).toHaveBeenCalledWith(
        expect.objectContaining({
          pickedSubprofileIds: [],
          fillOrder: 'endorsed',
          wallDay: '2026-07-01',
        }),
      );
    });
  });

  describe('adminView', () => {
    it('previews the wall with no viewer and tags each card with its source', async () => {
      storedSettings = { id: 1, fillOrder: 'newest' };
      const pickedCard = buildCard(FIRST_PERSONA_ID);
      const filledCard = buildCard(SECOND_PERSONA_ID);
      publicRead.listWallCards.mockResolvedValue([
        { card: pickedCard, wallSource: 'picked' },
        { card: filledCard, wallSource: 'filled' },
      ]);

      const adminView = await service.adminView();

      expect(publicRead.listWallCards).toHaveBeenCalledWith(
        expect.objectContaining({ viewerId: null, fillOrder: 'newest' }),
      );
      expect(adminView.fillOrder).toBe('newest');
      expect(adminView.preview).toEqual([
        { ...pickedCard, wallSource: 'picked' },
        { ...filledCard, wallSource: 'filled' },
      ]);
    });

    it('reads persona columns only for pick rows', async () => {
      storedPicks = [buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 1)];
      storedPersonas = [buildPersona()];

      await service.adminView();

      const personaFindCall = manager.find.mock.calls.find(
        ([entity]) => entity !== PersonaWallPick,
      ) as [unknown, { select: Record<string, boolean> }] | undefined;
      expect(personaFindCall).toBeDefined();
      expect(Object.keys(personaFindCall?.[1].select ?? {})).toEqual([
        'id',
        'handle',
        'displayName',
        'kind',
        'avatarUrl',
        'coverUrl',
        'accent',
        'status',
        'visibility',
        'removedAt',
      ]);
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([AVATAR_KEY]);
    });

    it('states why each pick is or is not shown', async () => {
      storedPicks = [
        buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 1),
        buildPick(SECOND_PICK_ID, SECOND_PERSONA_ID, 2),
        buildPick(THIRD_PICK_ID, THIRD_PERSONA_ID, 3),
        buildPick(FOURTH_PICK_ID, FOURTH_PERSONA_ID, 4),
      ];
      storedPersonas = [
        buildPersona(),
        buildPersona({
          id: SECOND_PERSONA_ID,
          status: SubprofileStatus.Draft,
        }),
        buildPersona({
          id: THIRD_PERSONA_ID,
          removedAt: new Date('2026-06-01T00:00:00Z'),
        }),
        // Published, open and kept: only the takedown hides it.
        buildPersona({ id: FOURTH_PERSONA_ID }),
      ];
      contentModeration.statesFor.mockResolvedValue(
        new Map([
          [THIRD_PERSONA_ID, { hidden: true, removed: false }],
          [FOURTH_PERSONA_ID, { hidden: true, removed: false }],
        ]),
      );

      const adminView = await service.adminView();

      expect(contentModeration.statesFor).toHaveBeenCalledWith('subprofile', [
        FIRST_PERSONA_ID,
        SECOND_PERSONA_ID,
        THIRD_PERSONA_ID,
        FOURTH_PERSONA_ID,
      ]);
      expect(adminView.picks.map((pick) => pick.publicState)).toEqual([
        'shown',
        'draft',
        'removed',
        'taken_down',
      ]);
      const firstPick = adminView.picks[0];
      expect(firstPick).toBeDefined();
      expect(firstPick!.persona).toEqual({
        id: FIRST_PERSONA_ID,
        handle: 'ana-poet',
        displayName: 'Ana Poet',
        kind: 'writer',
        imageUrl: `${API_BASE_URL}/files/${AVATAR_KEY}`,
        imageCrop: null,
        imageSource: 'avatar',
        accent: 'coral',
      });
    });

    it('reports positions 1 to n even after a cascade delete left a gap', async () => {
      storedPicks = [
        buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 1),
        buildPick(SECOND_PICK_ID, SECOND_PERSONA_ID, 3),
        buildPick(THIRD_PICK_ID, THIRD_PERSONA_ID, 4),
      ];
      storedPersonas = [
        buildPersona(),
        buildPersona({ id: SECOND_PERSONA_ID }),
        buildPersona({ id: THIRD_PERSONA_ID }),
      ];

      const adminView = await service.adminView();

      expect(adminView.picks.map((pick) => [pick.id, pick.position])).toEqual([
        [FIRST_PICK_ID, 1],
        [SECOND_PICK_ID, 2],
        [THIRD_PICK_ID, 3],
      ]);
    });

    it('drops a pick whose persona row is gone and numbers the rest 1 to n', async () => {
      storedPicks = [
        buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 1),
        buildPick(SECOND_PICK_ID, SECOND_PERSONA_ID, 2),
        buildPick(THIRD_PICK_ID, THIRD_PERSONA_ID, 3),
      ];
      // The second persona was deleted between the pick read and the persona
      // read, so the persona read answers the other two only.
      storedPersonas = [
        buildPersona(),
        buildPersona({ id: THIRD_PERSONA_ID, avatarUrl: THIRD_AVATAR_KEY }),
      ];

      const adminView = await service.adminView();

      expect(adminView.picks.map((pick) => [pick.id, pick.position])).toEqual([
        [FIRST_PICK_ID, 1],
        [THIRD_PICK_ID, 2],
      ]);
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([
        AVATAR_KEY,
        THIRD_AVATAR_KEY,
      ]);
      expect(mediaCropService.getMany).not.toHaveBeenCalledWith(
        expect.arrayContaining([SECOND_AVATAR_KEY]),
      );
    });
  });

  describe('searchPersonas', () => {
    it('answers no items for a blank, repeated or missing q and searches nothing', async () => {
      expect(await service.searchPersonas('  ')).toEqual({ items: [] });
      expect(await service.searchPersonas(['a', 'b'])).toEqual({ items: [] });
      expect(await service.searchPersonas(undefined)).toEqual({ items: [] });
      expect(publicRead.searchWallPersonas).not.toHaveBeenCalled();
    });

    it('searches at most 20 with a term cut to 100 code points and flags picked personas', async () => {
      publicRead.searchWallPersonas.mockResolvedValue([
        buildPersona(),
        buildPersona({ id: SECOND_PERSONA_ID, handle: 'bo-sings' }),
      ]);
      storedPicks = [buildPick(FIRST_PICK_ID, SECOND_PERSONA_ID, 1)];

      const results = await service.searchPersonas(`  ${'🌈'.repeat(120)}  `);

      expect(publicRead.searchWallPersonas).toHaveBeenCalledWith(
        '🌈'.repeat(100),
        20,
      );
      expect(
        results.items.map((result) => [result.persona.id, result.isPicked]),
      ).toEqual([
        [FIRST_PERSONA_ID, false],
        [SECOND_PERSONA_ID, true],
      ]);
    });
  });

  describe('addPick', () => {
    it('answers a malformed or non-string id with 400 PERSONA_WALL_PERSONA_NOT_FOUND before any query', async () => {
      expect(await codeOf(service.addPick(ADMIN_ID, 'nope'))).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_PERSONA_NOT_FOUND',
          status: 400,
        }),
      );
      expect(await codeOf(service.addPick(ADMIN_ID, 5))).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_PERSONA_NOT_FOUND',
          status: 400,
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('answers 404 PERSONA_WALL_PERSONA_NOT_FOUND when no persona has the id', async () => {
      personaForAdd = null;

      expect(await codeOf(service.addPick(ADMIN_ID, FIRST_PERSONA_ID))).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_PERSONA_NOT_FOUND',
          status: 404,
        }),
      );
      expect(manager.exists).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers 409 PERSONA_WALL_ALREADY_PICKED before the visibility check', async () => {
      personaForAdd = buildPersona({ status: SubprofileStatus.Draft });
      manager.exists.mockResolvedValue(true);

      expect(await codeOf(service.addPick(ADMIN_ID, FIRST_PERSONA_ID))).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_ALREADY_PICKED',
          status: 409,
        }),
      );
      expect(manager.exists).toHaveBeenCalledWith(PersonaWallPick, {
        where: { subprofileId: FIRST_PERSONA_ID },
      });
      expect(contentModeration.stateFor).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers 409 PERSONA_WALL_NOT_LISTED with the state for a hidden persona', async () => {
      personaForAdd = buildPersona({ status: SubprofileStatus.Draft });

      expect(await codeOf(service.addPick(ADMIN_ID, FIRST_PERSONA_ID))).toEqual(
        {
          code: 'PERSONA_WALL_NOT_LISTED',
          status: 409,
          publicState: 'draft',
        },
      );

      personaForAdd = buildPersona();
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      expect(await codeOf(service.addPick(ADMIN_ID, FIRST_PERSONA_ID))).toEqual(
        {
          code: 'PERSONA_WALL_NOT_LISTED',
          status: 409,
          publicState: 'taken_down',
        },
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'subprofile',
        FIRST_PERSONA_ID,
      );
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers 409 PERSONA_WALL_FULL with nine picks', async () => {
      manager.count.mockResolvedValue(9);

      expect(await codeOf(service.addPick(ADMIN_ID, FIRST_PERSONA_ID))).toEqual(
        expect.objectContaining({ code: 'PERSONA_WALL_FULL', status: 409 }),
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('locks the wall first and appends after the highest position', async () => {
      manager.count.mockResolvedValue(6);
      manager.maximum.mockResolvedValue(7);
      storedPicks = [buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 8)];
      storedPersonas = [buildPersona()];

      const adminView = await service.addPick(ADMIN_ID, FIRST_PERSONA_ID);

      expect(manager.query.mock.calls[0]).toEqual([LOCK_WALL_PICKS_SQL]);
      expect(LOCK_WALL_PICKS_SQL).toContain('"persona_wall_picks"');
      expect(LOCK_WALL_PICKS_SQL).toContain('SHARE ROW EXCLUSIVE');
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(manager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          where: { id: FIRST_PERSONA_ID },
          lock: { mode: 'pessimistic_read' },
        }),
      );
      expect(manager.maximum).toHaveBeenCalledWith(PersonaWallPick, 'position');
      expect(manager.create).toHaveBeenCalledWith(PersonaWallPick, {
        subprofileId: FIRST_PERSONA_ID,
        position: 8,
        addedById: ADMIN_ID,
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(adminView.picks).toEqual([
        expect.objectContaining({
          id: FIRST_PICK_ID,
          position: 1,
          publicState: 'shown',
        }),
      ]);
    });
  });

  describe('reorderPicks', () => {
    beforeEach(() => {
      storedPicks = [
        buildPick(FIRST_PICK_ID, FIRST_PERSONA_ID, 1),
        buildPick(SECOND_PICK_ID, SECOND_PERSONA_ID, 2),
      ];
    });

    it('answers PERSONA_WALL_REORDER_MISMATCH for a non-array, a repeated, a missing or a foreign id', async () => {
      expect(
        await codeOf(service.reorderPicks({ ids: FIRST_PICK_ID })),
      ).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_REORDER_MISMATCH',
          status: 409,
        }),
      );
      expect(await codeOf(service.reorderPicks([FIRST_PICK_ID, 7]))).toEqual(
        expect.objectContaining({ code: 'PERSONA_WALL_REORDER_MISMATCH' }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();

      for (const requestedIds of [
        [FIRST_PICK_ID, FIRST_PICK_ID],
        [FIRST_PICK_ID],
        [FIRST_PICK_ID, FOREIGN_PICK_ID],
      ]) {
        expect(await codeOf(service.reorderPicks(requestedIds))).toEqual(
          expect.objectContaining({
            code: 'PERSONA_WALL_REORDER_MISMATCH',
            status: 409,
          }),
        );
      }
      expect(manager.query).not.toHaveBeenCalledWith(
        REORDER_WALL_PICKS_SQL,
        expect.anything(),
      );
    });

    it('rewrites every position in one statement with the constraint deferred', async () => {
      await service.reorderPicks([SECOND_PICK_ID.toUpperCase(), FIRST_PICK_ID]);

      expect(manager.query.mock.calls).toEqual([
        [LOCK_WALL_PICKS_SQL],
        [DEFER_WALL_POSITION_SQL],
        [
          REORDER_WALL_PICKS_SQL,
          [
            [SECOND_PICK_ID, FIRST_PICK_ID],
            [1, 2],
          ],
        ],
      ]);
      expect(DEFER_WALL_POSITION_SQL).toContain(
        'SET CONSTRAINTS "UQ_persona_wall_picks_position" DEFERRED',
      );
      expect(callOrderOf(manager.query, 1)).toBeLessThan(
        callOrderOf(manager.find),
      );
      expect(manager.find).toHaveBeenNthCalledWith(1, PersonaWallPick, {
        select: { id: true },
      });
    });
  });

  describe('removePick', () => {
    it('answers 404 PERSONA_WALL_PICK_NOT_FOUND for a malformed or unknown id', async () => {
      expect(await codeOf(service.removePick('nope'))).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_PICK_NOT_FOUND',
          status: 404,
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();

      expect(await codeOf(service.removePick(SECOND_PICK_ID))).toEqual(
        expect.objectContaining({
          code: 'PERSONA_WALL_PICK_NOT_FOUND',
          status: 404,
        }),
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('deletes the pick and closes the gap behind it', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: SECOND_PICK_ID,
        position: 3,
      });

      await service.removePick(SECOND_PICK_ID);

      expect(manager.query.mock.calls[0]).toEqual([LOCK_WALL_PICKS_SQL]);
      expect(manager.findOne).toHaveBeenCalledWith(PersonaWallPick, {
        where: { id: SECOND_PICK_ID },
        select: { id: true, position: true },
      });
      expect(manager.delete).toHaveBeenCalledWith(PersonaWallPick, {
        id: SECOND_PICK_ID,
      });
      const closeGapCallIndex = manager.query.mock.calls.findIndex(
        ([sql]) => sql === CLOSE_WALL_POSITION_GAP_SQL,
      );
      expect(manager.query.mock.calls[closeGapCallIndex]).toEqual([
        CLOSE_WALL_POSITION_GAP_SQL,
        [3],
      ]);
      expect(callOrderOf(manager.delete)).toBeLessThan(
        callOrderOf(manager.query, closeGapCallIndex),
      );
    });
  });

  describe('updateSettings', () => {
    it('answers 400 PERSONA_WALL_INVALID_FILL_ORDER for anything but the four orders', async () => {
      for (const fillOrder of ['shuffle', undefined, 5]) {
        expect(
          await codeOf(service.updateSettings(ADMIN_ID, fillOrder)),
        ).toEqual(
          expect.objectContaining({
            code: 'PERSONA_WALL_INVALID_FILL_ORDER',
            status: 400,
          }),
        );
      }
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('upserts the single settings row with who changed it', async () => {
      await service.updateSettings(ADMIN_ID, 'daily_shuffle');

      expect(manager.query).toHaveBeenCalledWith(UPSERT_WALL_SETTINGS_SQL, [
        'daily_shuffle',
        ADMIN_ID,
      ]);
      expect(UPSERT_WALL_SETTINGS_SQL).toContain('ON CONFLICT ("id")');
      expect(UPSERT_WALL_SETTINGS_SQL).toContain('VALUES (1, $1, $2, now())');
    });
  });
});
