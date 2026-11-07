import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryFailedError } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { VjPack } from './entities/vj-pack.entity';
import {
  LOCK_VJ_PACKS_ROW_EXCLUSIVE_SQL,
  VJ_EVENT_CARD_COLUMNS,
  VJ_MEMBER_WITHHELD_EVENT_IDS_SQL,
  VJ_PACK_EVENT_CARD_SQL,
  VJ_UPCOMING_EVENTS_SQL,
  VjEventLinkService,
} from './vj-event-link.service';
import { readVjPackDto } from './vj-library-reads';
import type { VjEventRow, VjPackDTO } from './vj-response';
import { VJ_LIBRARY_CHANGED } from './vj.contract';

jest.mock('./vj-library-reads', () => ({
  ...jest.requireActual<typeof import('./vj-library-reads')>(
    './vj-library-reads',
  ),
  readVjPackDto: jest.fn(),
}));

const readVjPackDtoMock = readVjPackDto as jest.MockedFunction<
  typeof readVjPackDto
>;

const FRONTEND_URL = 'https://queerpulse.example.test';
const EVENT_START = new Date('2026-11-20T21:00:00.000Z');
const EVENT_END = new Date('2026-11-21T03:00:00.000Z');
const EVENT_TITLE = 'Glitter night at the docks';
const EVENT_SLUG = 'glitter-night-at-the-docks';

/** A v4 uuid in a numbered family: 1 packs, 4 events. */
function uuidAt(family: number, position: number): string {
  return `a7120000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const OTHER_PACK_ID = uuidAt(1, 2);
const EVENT_ID = uuidAt(4, 1);
const OTHER_EVENT_ID = uuidAt(4, 2);

/** An admin reads every listed event; a member holding the `vj_operator`
 *  grant reads only what a plain member could find in the event listings. */
const ADMIN_VIEWER = { role: 'admin' };
const VJ_OPERATOR_VIEWER = { role: 'member' };
const MODERATOR_VIEWER = { role: 'moderator' };

/** Every property name of `VjEventRow`, in its declared order. */
const VJ_EVENT_ROW_PROPERTIES: readonly (keyof VjEventRow)[] = [
  'id',
  'title',
  'slug',
  'startAt',
  'endAt',
  'timezone',
  'neighbourhood',
  'isOnline',
  'status',
  'visibility',
];

/** Event columns no VJ read may ever select. */
const FORBIDDEN_EVENT_COLUMNS = [
  'host_id',
  'address',
  'arrival_notes',
  'description',
  'community_id',
  'listing_id',
  'run_by_listing_id',
  'persona_id',
];

interface RefusalOutcome {
  code?: string;
  status?: number;
  message?: string;
}

async function refusalOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    if (!(error instanceof HttpException)) {
      throw error;
    }
    const body = error.getResponse() as Record<string, unknown>;
    return {
      code: body.code as string | undefined,
      status: error.getStatus(),
      message: body.message as string | undefined,
    };
  }
}

/** One event row as the driver hands back the card columns. */
function rawEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: EVENT_ID,
    title: EVENT_TITLE,
    slug: EVENT_SLUG,
    start_at: EVENT_START,
    end_at: EVENT_END.toISOString(),
    timezone: 'Europe/Lisbon',
    neighbourhood: 'Arroios',
    is_online: false,
    status: 'published',
    visibility: 'members',
    ...overrides,
  };
}

/** One `VJ_PACK_EVENT_CARD_SQL` row: the pack and its linked event's
 *  columns prefixed `event_`. */
function rawCardRow(
  event: Record<string, unknown> | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = { pack_id: PACK_ID };
  for (const column of VJ_EVENT_CARD_COLUMNS) {
    row[`event_${column}`] = event === null ? null : event[column];
  }
  return row;
}

/** The event columns a SQL string selects as `"event"."<column>"`, in
 *  order, from its SELECT clause only. */
function selectedEventColumns(sql: string): string[] {
  const selectClause = sql.slice(0, sql.indexOf('\nFROM'));
  return [...selectClause.matchAll(/"event"\."([a-z_]+)"/g)].map(
    (match) => match[1] ?? '',
  );
}

function foreignKeyViolation(constraint: string): QueryFailedError {
  return new QueryFailedError('UPDATE', [], {
    code: '23503',
    constraint,
  } as unknown as Error);
}

describe('VjEventLinkService', () => {
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let dataSource: { manager: typeof manager; transaction: jest.Mock };
  let config: { get: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: VjEventLinkService;
  let storedPack: { id: string; eventId: string | null } | null;
  let storedEvent: { id: string; status: string; visibility: string } | null;
  const packDto = { id: PACK_ID } as VjPackDTO;

  beforeEach(() => {
    storedPack = { id: PACK_ID, eventId: null };
    storedEvent = { id: EVENT_ID, status: 'published', visibility: 'public' };
    manager = {
      query: jest.fn(),
      findOne: jest.fn((entity: unknown) => {
        if (entity === VjPack) {
          return Promise.resolve(storedPack);
        }
        if (entity === Event) {
          return Promise.resolve(storedEvent);
        }
        return Promise.resolve(null);
      }),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    dataSource = {
      manager,
      transaction: jest.fn(
        async (work: (transactionManager: typeof manager) => unknown) =>
          work(manager),
      ),
    };
    config = { get: jest.fn(() => FRONTEND_URL) };
    eventEmitter = { emit: jest.fn() };
    readVjPackDtoMock.mockReset();
    readVjPackDtoMock.mockResolvedValue(packDto);
    service = new VjEventLinkService(
      dataSource as unknown as DataSource,
      config as unknown as ConfigService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('setPackEvent', () => {
    it('checks a pack event link in the contract order', async () => {
      expect(
        await refusalOf(
          service.setPackEvent('pack-1', { eventId: 'x' }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_PACK_NOT_FOUND', status: 404 });
      expect(dataSource.transaction).not.toHaveBeenCalled();

      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: 'x' }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_FOUND', status: 404 });
      expect(
        await refusalOf(service.setPackEvent(PACK_ID, {}, ADMIN_VIEWER)),
      ).toMatchObject({
        code: 'VJ_EVENT_NOT_FOUND',
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();

      storedPack = null;
      storedEvent = null;
      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_PACK_NOT_FOUND', status: 404 });

      storedPack = { id: PACK_ID, eventId: null };
      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_FOUND', status: 404 });

      storedEvent = { id: EVENT_ID, status: 'draft', visibility: 'public' };
      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_LINKABLE', status: 409 });

      storedEvent = {
        id: EVENT_ID,
        status: 'published',
        visibility: 'invite_only',
      };
      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_LINKABLE', status: 409 });

      storedEvent = { id: EVENT_ID, status: 'cancelled', visibility: 'public' };
      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_LINKABLE' });

      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('reads the pack for update and only the id, status and visibility of the event', async () => {
      await service.setPackEvent(
        PACK_ID,
        { eventId: EVENT_ID.toUpperCase() },
        ADMIN_VIEWER,
      );

      expect(manager.findOne).toHaveBeenCalledWith(VjPack, {
        where: { id: PACK_ID },
        select: { id: true, eventId: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.findOne).toHaveBeenCalledWith(Event, {
        where: { id: EVENT_ID },
        select: { id: true, status: true, visibility: true },
      });
    });

    it('links an event and emits the change after commit', async () => {
      const result = await service.setPackEvent(
        PACK_ID,
        {
          eventId: EVENT_ID,
        },
        ADMIN_VIEWER,
      );

      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: PACK_ID },
        { eventId: EVENT_ID },
      );
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_event_changed',
        packId: PACK_ID,
        clipId: null,
        packIds: [],
        sceneId: null,
        setlistId: null,
        setlistIds: [],
        eventId: EVENT_ID,
      });
      const transactionOrder =
        dataSource.transaction.mock.invocationCallOrder[0] ?? 0;
      const emitOrder = eventEmitter.emit.mock.invocationCallOrder[0];
      expect(emitOrder).toBeGreaterThan(transactionOrder);
      expect(readVjPackDtoMock).toHaveBeenCalledWith(manager, PACK_ID);
      expect(result).toBe(packDto);
    });

    it('unlinks with null and emits the change with a null event id', async () => {
      storedPack = { id: PACK_ID, eventId: EVENT_ID };

      await service.setPackEvent(PACK_ID, { eventId: null }, ADMIN_VIEWER);

      expect(manager.findOne).not.toHaveBeenCalledWith(
        Event,
        expect.anything(),
      );
      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: PACK_ID },
        { eventId: null },
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        VJ_LIBRARY_CHANGED,
        expect.objectContaining({
          kind: 'pack_event_changed',
          packId: PACK_ID,
          eventId: null,
        }),
      );
    });

    it('writes and emits nothing for the same event', async () => {
      storedPack = { id: PACK_ID, eventId: EVENT_ID };

      const result = await service.setPackEvent(
        PACK_ID,
        {
          eventId: EVENT_ID,
        },
        ADMIN_VIEWER,
      );

      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(result).toBe(packDto);
    });

    it('answers the pack for the linked event after it was cancelled', async () => {
      storedPack = { id: PACK_ID, eventId: EVENT_ID };
      storedEvent = { id: EVENT_ID, status: 'cancelled', visibility: 'public' };

      const result = await service.setPackEvent(
        PACK_ID,
        {
          eventId: EVENT_ID.toUpperCase(),
        },
        ADMIN_VIEWER,
      );

      expect(result).toBe(packDto);
      expect(manager.findOne).not.toHaveBeenCalledWith(
        Event,
        expect.anything(),
      );
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('takes the pack table lock before the pack row', async () => {
      await service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER);

      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        LOCK_VJ_PACKS_ROW_EXCLUSIVE_SQL,
      );
      const lockOrder = manager.query.mock.invocationCallOrder[0] ?? 0;
      const packReadOrder = manager.findOne.mock.invocationCallOrder[0] ?? 0;
      expect(lockOrder).toBeGreaterThan(0);
      expect(packReadOrder).toBeGreaterThan(lockOrder);
      expect(LOCK_VJ_PACKS_ROW_EXCLUSIVE_SQL).toBe(
        'LOCK TABLE "vj_packs" IN ROW EXCLUSIVE MODE',
      );
    });

    it('writes and emits nothing for null on an unlinked pack', async () => {
      await service.setPackEvent(PACK_ID, { eventId: null }, ADMIN_VIEWER);

      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('moves the link from one event to another', async () => {
      storedPack = { id: PACK_ID, eventId: OTHER_EVENT_ID };

      await service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER);

      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: PACK_ID },
        { eventId: EVENT_ID },
      );
    });

    it('links an event that already ended', async () => {
      // The link check reads status and visibility only, so an event whose
      // dates are long past still links.
      storedEvent = {
        id: EVENT_ID,
        status: 'published',
        visibility: 'members',
      };

      await service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER);

      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    });

    it('answers VJ_EVENT_NOT_FOUND when the event goes before the write commits', async () => {
      manager.update.mockRejectedValueOnce(
        foreignKeyViolation('FK_vj_packs_event'),
      );

      expect(
        await refusalOf(
          service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_FOUND' });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getPackEvent', () => {
    it('answers VJ_PACK_NOT_FOUND for a malformed or unknown pack', async () => {
      expect(
        await refusalOf(service.getPackEvent('nope', ADMIN_VIEWER)),
      ).toMatchObject({
        code: 'VJ_PACK_NOT_FOUND',
        status: 404,
      });
      expect(manager.query).not.toHaveBeenCalled();

      manager.query.mockResolvedValueOnce([]);
      expect(
        await refusalOf(service.getPackEvent(PACK_ID, ADMIN_VIEWER)),
      ).toMatchObject({
        code: 'VJ_PACK_NOT_FOUND',
      });
      expect(manager.query).toHaveBeenCalledWith(VJ_PACK_EVENT_CARD_SQL, [
        PACK_ID,
      ]);
    });

    it('answers a null card and reason for a pack with no link', async () => {
      manager.query.mockResolvedValueOnce([rawCardRow(null)]);

      expect(
        await service.getPackEvent(PACK_ID.toUpperCase(), ADMIN_VIEWER),
      ).toEqual({
        packId: PACK_ID,
        card: null,
        unavailableReason: null,
      });
    });

    it('answers the card, cancelled or not listed', async () => {
      manager.query.mockResolvedValueOnce([rawCardRow(rawEvent())]);
      expect(await service.getPackEvent(PACK_ID, ADMIN_VIEWER)).toEqual({
        packId: PACK_ID,
        card: {
          eventId: EVENT_ID,
          title: EVENT_TITLE,
          startAt: EVENT_START.toISOString(),
          endAt: EVENT_END.toISOString(),
          timezone: 'Europe/Lisbon',
          area: 'Arroios',
          isOnline: false,
          publicUrl: `${FRONTEND_URL}/gatherings/${EVENT_SLUG}`,
        },
        unavailableReason: null,
      });
      expect(config.get).toHaveBeenCalledWith('app.frontendUrl');

      manager.query.mockResolvedValueOnce([
        rawCardRow(rawEvent({ status: 'cancelled', visibility: 'public' })),
      ]);
      expect(await service.getPackEvent(PACK_ID, ADMIN_VIEWER)).toEqual({
        packId: PACK_ID,
        card: null,
        unavailableReason: 'cancelled',
      });

      manager.query.mockResolvedValueOnce([
        rawCardRow(rawEvent({ status: 'draft' })),
      ]);
      expect(await service.getPackEvent(PACK_ID, ADMIN_VIEWER)).toEqual({
        packId: PACK_ID,
        card: null,
        unavailableReason: 'not_listed',
      });

      manager.query.mockResolvedValueOnce([
        rawCardRow(rawEvent({ visibility: 'network' })),
      ]);
      expect(await service.getPackEvent(PACK_ID, ADMIN_VIEWER)).toEqual({
        packId: PACK_ID,
        card: null,
        unavailableReason: 'not_listed',
      });
    });

    it('answers a null publicUrl when FRONTEND_URL is unset', async () => {
      config.get.mockReturnValue(undefined);
      manager.query.mockResolvedValueOnce([
        rawCardRow(rawEvent({ end_at: null, is_online: true })),
      ]);

      const result = await service.getPackEvent(PACK_ID, ADMIN_VIEWER);

      expect(result.card).toMatchObject({
        endAt: null,
        isOnline: true,
        publicUrl: null,
      });
    });
  });

  describe('listUpcomingEvents', () => {
    it('lists upcoming events with the contract filter and order', async () => {
      manager.query.mockResolvedValueOnce([
        rawEvent(),
        rawEvent({
          id: OTHER_EVENT_ID,
          title: 'Online zine swap',
          start_at: '2026-11-22T18:00:00.000Z',
          end_at: null,
          neighbourhood: null,
          is_online: true,
          visibility: 'public',
        }),
      ]);

      const result = await service.listUpcomingEvents(ADMIN_VIEWER);

      expect(manager.query).toHaveBeenCalledWith(VJ_UPCOMING_EVENTS_SQL);
      expect(VJ_UPCOMING_EVENTS_SQL).toContain(
        `WHERE "event"."status" = 'published' AND "event"."visibility" IN ('public', 'members') AND "event"."start_at" >= now() - interval '12 hours' AND COALESCE("event"."end_at", "event"."start_at" + interval '6 hours') >= now()`,
      );
      expect(VJ_UPCOMING_EVENTS_SQL).toContain(
        'ORDER BY "event"."start_at" ASC, "event"."id" ASC\nLIMIT 50',
      );
      expect(result).toEqual({
        items: [
          {
            id: EVENT_ID,
            title: EVENT_TITLE,
            startAt: EVENT_START.toISOString(),
            endAt: EVENT_END.toISOString(),
            area: 'Arroios',
            isOnline: false,
          },
          {
            id: OTHER_EVENT_ID,
            title: 'Online zine swap',
            startAt: '2026-11-22T18:00:00.000Z',
            endAt: null,
            area: null,
            isOnline: true,
          },
        ],
      });
    });
  });

  describe('a caller outside the platform staff tiers (vj_operator)', () => {
    /** Answers the card read, the upcoming read and the withheld read by
     *  SQL, the withheld read naming `withheldEventIds`. */
    function answerQueries(options: {
      cardRow?: Record<string, unknown>;
      upcomingRows?: Record<string, unknown>[];
      withheldEventIds?: string[];
    }): void {
      manager.query.mockImplementation(
        (sql: string, parameters?: unknown[]) => {
          if (sql === VJ_PACK_EVENT_CARD_SQL) {
            return Promise.resolve(options.cardRow ? [options.cardRow] : []);
          }
          if (sql === VJ_UPCOMING_EVENTS_SQL) {
            return Promise.resolve(options.upcomingRows ?? []);
          }
          if (sql === VJ_MEMBER_WITHHELD_EVENT_IDS_SQL) {
            const [askedIds] = (parameters ?? []) as [string[]];
            return Promise.resolve(
              (options.withheldEventIds ?? [])
                .filter((eventId) => askedIds.includes(eventId))
                .map((eventId) => ({ id: eventId })),
            );
          }
          return Promise.resolve(undefined);
        },
      );
    }

    const withheldReads = (): unknown[][] =>
      (manager.query.mock.calls as unknown[][]).filter(
        ([sql]) => sql === VJ_MEMBER_WITHHELD_EVENT_IDS_SQL,
      );

    it('leaves the events members cannot find out of the upcoming list', async () => {
      answerQueries({
        upcomingRows: [
          rawEvent(),
          rawEvent({ id: OTHER_EVENT_ID, title: 'Hidden by moderation' }),
        ],
        withheldEventIds: [OTHER_EVENT_ID],
      });

      const operatorList = await service.listUpcomingEvents(VJ_OPERATOR_VIEWER);

      expect(operatorList.items.map((item) => item.id)).toEqual([EVENT_ID]);
      expect(manager.query).toHaveBeenCalledWith(
        VJ_MEMBER_WITHHELD_EVENT_IDS_SQL,
        [[EVENT_ID, OTHER_EVENT_ID]],
      );

      manager.query.mockClear();
      for (const viewer of [ADMIN_VIEWER, MODERATOR_VIEWER]) {
        const staffList = await service.listUpcomingEvents(viewer);
        expect(staffList.items.map((item) => item.id)).toEqual([
          EVENT_ID,
          OTHER_EVENT_ID,
        ]);
      }
      expect(withheldReads()).toEqual([]);
    });

    it('answers not_listed for a linked event members cannot find', async () => {
      answerQueries({
        cardRow: rawCardRow(rawEvent()),
        withheldEventIds: [EVENT_ID],
      });

      expect(await service.getPackEvent(PACK_ID, VJ_OPERATOR_VIEWER)).toEqual({
        packId: PACK_ID,
        card: null,
        unavailableReason: 'not_listed',
      });
      expect(
        (await service.getPackEvent(PACK_ID, ADMIN_VIEWER)).card,
      ).toMatchObject({ eventId: EVENT_ID, title: EVENT_TITLE });

      answerQueries({ cardRow: rawCardRow(rawEvent()), withheldEventIds: [] });
      expect(
        (await service.getPackEvent(PACK_ID, VJ_OPERATOR_VIEWER)).card,
      ).toMatchObject({ eventId: EVENT_ID, title: EVENT_TITLE });
    });

    it('refuses to link an event members cannot find with VJ_EVENT_NOT_LINKABLE', async () => {
      answerQueries({ withheldEventIds: [EVENT_ID] });

      expect(
        await refusalOf(
          service.setPackEvent(
            PACK_ID,
            { eventId: EVENT_ID },
            VJ_OPERATOR_VIEWER,
          ),
        ),
      ).toMatchObject({ code: 'VJ_EVENT_NOT_LINKABLE', status: 409 });
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();

      await service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER);
      expect(manager.update).toHaveBeenCalledTimes(1);
    });

    it('withholds the title and start of a linked event members cannot see', async () => {
      answerQueries({ withheldEventIds: [OTHER_EVENT_ID] });
      const basePack = {
        id: PACK_ID,
        name: 'Peak hour',
        position: 0,
        clipCount: 0,
        totalByteSize: 0,
        coverThumbnailUrl: null,
        createdBy: null,
        createdAt: EVENT_START.toISOString(),
        updatedAt: EVENT_START.toISOString(),
      };
      const listedPack: VjPackDTO = {
        ...basePack,
        event: {
          id: EVENT_ID,
          title: EVENT_TITLE,
          startAt: EVENT_START.toISOString(),
          isAvailable: true,
        },
      };
      const moderatedPack: VjPackDTO = {
        ...basePack,
        id: OTHER_PACK_ID,
        event: {
          id: OTHER_EVENT_ID,
          title: 'Hidden by moderation',
          startAt: EVENT_START.toISOString(),
          isAvailable: true,
        },
      };
      const privatePack: VjPackDTO = {
        ...basePack,
        id: uuidAt(1, 3),
        event: {
          id: uuidAt(4, 3),
          title: 'Now invite only',
          startAt: EVENT_START.toISOString(),
          isAvailable: false,
        },
      };
      const unlinkedPack: VjPackDTO = {
        ...basePack,
        id: uuidAt(1, 4),
        event: null,
      };
      const packs = [listedPack, moderatedPack, privatePack, unlinkedPack];

      const operatorPacks = await service.packsAsSeenBy(
        packs,
        VJ_OPERATOR_VIEWER,
      );

      expect(operatorPacks[0]).toEqual(listedPack);
      expect(operatorPacks[1]?.event).toEqual({
        id: OTHER_EVENT_ID,
        isAvailable: false,
      });
      expect(operatorPacks[2]?.event).toEqual({
        id: uuidAt(4, 3),
        isAvailable: false,
      });
      expect(operatorPacks[3]).toEqual(unlinkedPack);
      // One read, only for the events a status and visibility would list.
      expect(withheldReads()).toEqual([
        [VJ_MEMBER_WITHHELD_EVENT_IDS_SQL, [[EVENT_ID, OTHER_EVENT_ID]]],
      ]);
      expect(JSON.stringify(operatorPacks)).not.toContain('Now invite only');
      expect(JSON.stringify(operatorPacks)).not.toContain(
        'Hidden by moderation',
      );

      manager.query.mockClear();
      expect(await service.packsAsSeenBy(packs, ADMIN_VIEWER)).toEqual(packs);
      expect(await service.packsAsSeenBy(packs, MODERATOR_VIEWER)).toEqual(
        packs,
      );
      const packList = { items: packs };
      expect(await service.packListAsSeenBy(packList, ADMIN_VIEWER)).toBe(
        packList,
      );
      expect(withheldReads()).toEqual([]);

      expect(
        await service.packsAsSeenBy([unlinkedPack], VJ_OPERATOR_VIEWER),
      ).toEqual([unlinkedPack]);
      expect(withheldReads()).toEqual([]);
    });

    it('narrows the pack of a pack and clips answer', async () => {
      answerQueries({ withheldEventIds: [EVENT_ID] });
      const pack = {
        id: PACK_ID,
        event: {
          id: EVENT_ID,
          title: EVENT_TITLE,
          startAt: EVENT_START.toISOString(),
          isAvailable: true,
        },
      } as VjPackDTO;

      const packClips = await service.packClipsAsSeenBy(
        { pack, items: [] },
        VJ_OPERATOR_VIEWER,
      );

      expect(packClips.pack.event).toEqual({
        id: EVENT_ID,
        isAvailable: false,
      });
      expect(packClips.items).toEqual([]);
    });

    it('reads only the event id when it checks what members can find', () => {
      expect(selectedEventColumns(VJ_MEMBER_WITHHELD_EVENT_IDS_SQL)).toEqual([
        'id',
      ]);
      expect(VJ_MEMBER_WITHHELD_EVENT_IDS_SQL).toContain(
        '"content_moderation"',
      );
      expect(VJ_MEMBER_WITHHELD_EVENT_IDS_SQL).toContain(
        '"host_community"."parent_id" IS NOT NULL',
      );
      expect(VJ_MEMBER_WITHHELD_EVENT_IDS_SQL).not.toMatch(
        /rsvp|cohost|persona|attendee|host_id|address/i,
      );
    });
  });

  describe('privacy', () => {
    it('selects no host, attendee or address column', async () => {
      expect(VJ_EVENT_CARD_COLUMNS).toHaveLength(
        VJ_EVENT_ROW_PROPERTIES.length,
      );
      expect(
        VJ_EVENT_CARD_COLUMNS.map((column) =>
          column.replace(/_([a-z])/g, (_match, letter: string) =>
            letter.toUpperCase(),
          ),
        ),
      ).toEqual(VJ_EVENT_ROW_PROPERTIES);
      expect(selectedEventColumns(VJ_UPCOMING_EVENTS_SQL)).toEqual([
        ...VJ_EVENT_CARD_COLUMNS,
      ]);
      expect(selectedEventColumns(VJ_PACK_EVENT_CARD_SQL)).toEqual([
        ...VJ_EVENT_CARD_COLUMNS,
      ]);
      for (const sql of [VJ_UPCOMING_EVENTS_SQL, VJ_PACK_EVENT_CARD_SQL]) {
        for (const column of FORBIDDEN_EVENT_COLUMNS) {
          expect(sql).not.toContain(`"${column}"`);
        }
        expect(sql).not.toMatch(/rsvp|cohost|persona|attendee/i);
      }

      await service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER);
      const eventRead = manager.findOne.mock.calls.find(
        ([entity]) => entity === Event,
      ) as [unknown, { select: Record<string, boolean> }] | undefined;
      expect(eventRead).toBeDefined();
      for (const property of Object.keys(eventRead?.[1].select ?? {})) {
        expect(VJ_EVENT_ROW_PROPERTIES).toContain(property);
      }
    });

    it('logs no event title', async () => {
      const logSpies = (
        ['log', 'warn', 'error', 'debug', 'verbose'] as const
      ).map((method) =>
        jest
          .spyOn(Logger.prototype, method)
          .mockImplementation(() => undefined),
      );
      manager.query.mockResolvedValueOnce([rawCardRow(rawEvent())]);
      await service.getPackEvent(PACK_ID, ADMIN_VIEWER);
      manager.query.mockResolvedValueOnce([rawEvent()]);
      await service.listUpcomingEvents(ADMIN_VIEWER);
      await service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER);
      storedEvent = { id: EVENT_ID, status: 'draft', visibility: 'public' };
      storedPack = { id: PACK_ID, eventId: null };
      const refusal = await refusalOf(
        service.setPackEvent(PACK_ID, { eventId: EVENT_ID }, ADMIN_VIEWER),
      );

      for (const spy of logSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(refusal.message).toBeDefined();
      expect(refusal.message).not.toContain(EVENT_TITLE);
      expect(refusal.message).not.toContain(EVENT_SLUG);
    });
  });
});
