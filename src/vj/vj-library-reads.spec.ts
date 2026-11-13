import { HttpException } from '@nestjs/common';
import { EntityManager, FindOperator } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { VjClip } from './entities/vj-clip.entity';
import {
  readVjClipDto,
  readVjClipPackIds,
  readVjClipSetlistItemCounts,
  readVjCreatorProfiles,
  readVjPackDto,
  readVjPackSummaries,
  toVjClipDtos,
  VJ_CLIP_SETLIST_ITEM_COUNTS_SQL,
  VJ_PACK_SUMMARY_V2_SQL,
} from './vj-library-reads';

const API_BASE_URL = 'https://api.example.test';
const NOW = new Date('2026-11-06T12:00:00.000Z');
const EVENT_START = '2026-11-20T21:00:00.000Z';

/** A v4 uuid in a numbered family: 1 packs, 2 clips, 3 users, 4 events,
 *  5 and 6 key segments. */
function uuidAt(family: number, position: number): string {
  return `a7110000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const OTHER_PACK_ID = uuidAt(1, 2);
const CLIP_ID = uuidAt(2, 1);
const OTHER_CLIP_ID = uuidAt(2, 2);
const ADMIN_ID = uuidAt(3, 1);
const OTHER_ADMIN_ID = uuidAt(3, 2);
const EVENT_ID = uuidAt(4, 1);
const CLIP_KEY = `vj-clips/${uuidAt(5, 1)}/${uuidAt(6, 1)}.mp4`;
const THUMBNAIL_KEY = `vj-thumbnails/${uuidAt(5, 1)}/${uuidAt(6, 1)}.webp`;
const PREVIEW_KEY = `vj-previews/${uuidAt(5, 1)}/${uuidAt(6, 1)}.webm`;

/** A summary row as the driver hands back `VJ_PACK_SUMMARY_V2_SQL`. */
function rawSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: PACK_ID,
    name: 'Peak hour',
    position: 0,
    created_by_user_id: ADMIN_ID,
    created_at: NOW,
    updated_at: NOW.toISOString(),
    clip_count: '2',
    total_byte_size: '4096',
    cover_thumbnail_key: THUMBNAIL_KEY,
    event_id: null,
    event_title: null,
    event_start_at: null,
    event_status: null,
    event_visibility: null,
    ...overrides,
  };
}

function linkedEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    event_title: 'Glitter night',
    event_start_at: EVENT_START,
    event_status: 'published',
    event_visibility: 'members',
    ...overrides,
  };
}

function buildClip(overrides: Partial<VjClip> = {}): VjClip {
  return {
    id: CLIP_ID,
    title: 'Glitter tunnel loop',
    mediaKind: 'video',
    mimeType: 'video/mp4',
    byteSize: 2048,
    width: 1920,
    height: 1080,
    durationMs: 8000,
    storageKey: CLIP_KEY,
    thumbnailStorageKey: THUMBNAIL_KEY,
    fitMode: 'fill',
    createdByUserId: ADMIN_ID,
    createdAt: NOW,
    updatedAt: NOW,
    isFavorite: true,
    defaultSpeed: 1.5,
    loopInMs: 500,
    loopOutMs: 6000,
    loopMode: 'pingPong',
    previewStorageKey: PREVIEW_KEY,
    ...overrides,
  } as VjClip;
}

const PROFILES = [
  { userId: ADMIN_ID, firstName: 'Ana', lastName: 'Lima' },
  { userId: OTHER_ADMIN_ID, firstName: 'Rui', lastName: 'Sousa' },
];

interface MockManager {
  query: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
}

function buildManager(): MockManager {
  return {
    query: jest.fn().mockResolvedValue([]),
    find: jest.fn(
      (entity: unknown, options: { where: { userId: unknown } }) => {
        if (entity !== Profile) {
          throw new Error('Unexpected entity');
        }
        const operator = options.where.userId as FindOperator<string[]>;
        return Promise.resolve(
          PROFILES.filter((profile) => operator.value.includes(profile.userId)),
        );
      },
    ),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function asManager(manager: MockManager): EntityManager {
  return manager as unknown as EntityManager;
}

async function refusalCodeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (!(error instanceof HttpException)) {
      throw error;
    }
    return (error.getResponse() as Record<string, unknown>).code;
  }
}

describe('vj-library-reads', () => {
  beforeAll(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterAll(() => {
    resetImageUrlBaseForTesting();
  });

  it('reads pack summaries with the event summary and null without a link', async () => {
    const eventColumns = [
      ...VJ_PACK_SUMMARY_V2_SQL.matchAll(/"event"\."([a-z_]+)"/g),
    ].map((match) => match[1]);
    expect(new Set(eventColumns)).toEqual(
      new Set(['id', 'title', 'start_at', 'status', 'visibility']),
    );
    expect(VJ_PACK_SUMMARY_V2_SQL).toContain('"event"."title"');
    expect(VJ_PACK_SUMMARY_V2_SQL).toContain(
      'LEFT JOIN "events" "event" ON "event"."id" = "pack"."event_id"',
    );
    expect(VJ_PACK_SUMMARY_V2_SQL).toContain(
      'GROUP BY "pack"."id", "event"."id"',
    );
    expect(VJ_PACK_SUMMARY_V2_SQL).not.toMatch(/"event"\.\*/);

    const manager = buildManager();
    manager.query.mockResolvedValueOnce([
      rawSummary(linkedEvent()),
      rawSummary({ id: OTHER_PACK_ID, position: 1, created_by_user_id: null }),
    ]);
    const rows = await readVjPackSummaries(asManager(manager), null);

    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(VJ_PACK_SUMMARY_V2_SQL, [null]);
    expect(rows).toEqual([
      {
        summary: {
          id: PACK_ID,
          name: 'Peak hour',
          position: 0,
          createdByUserId: ADMIN_ID,
          createdAt: NOW,
          updatedAt: NOW,
          clipCount: 2,
          totalByteSize: 4096,
          coverThumbnailKey: THUMBNAIL_KEY,
        },
        event: {
          id: EVENT_ID,
          title: 'Glitter night',
          startAt: new Date(EVENT_START),
          status: 'published',
          visibility: 'members',
        },
      },
      expect.objectContaining({ event: null }),
    ]);
    expect(rows[1]?.summary.id).toBe(OTHER_PACK_ID);
  });

  it('answers a pack DTO with its event summary', async () => {
    const manager = buildManager();
    manager.query.mockResolvedValueOnce([
      rawSummary(linkedEvent({ event_status: 'cancelled' })),
    ]);
    const pack = await readVjPackDto(asManager(manager), PACK_ID);

    expect(manager.query).toHaveBeenCalledWith(VJ_PACK_SUMMARY_V2_SQL, [
      PACK_ID,
    ]);
    expect(pack.event).toEqual({
      id: EVENT_ID,
      title: 'Glitter night',
      startAt: EVENT_START,
      isAvailable: false,
    });
    expect(pack.createdBy).toEqual({
      userId: ADMIN_ID,
      displayName: 'Ana Lima',
    });
    expect(pack.coverThumbnailUrl).toBe(
      `${API_BASE_URL}/files/${THUMBNAIL_KEY}`,
    );

    manager.query.mockResolvedValueOnce([rawSummary()]);
    await expect(
      readVjPackDto(asManager(manager), PACK_ID),
    ).resolves.toMatchObject({ id: PACK_ID, event: null });
  });

  it('answers VJ_PACK_NOT_FOUND for a pack gone since the write', async () => {
    const manager = buildManager();
    manager.query.mockResolvedValueOnce([]);
    await expect(
      refusalCodeOf(readVjPackDto(asManager(manager), PACK_ID)),
    ).resolves.toBe('VJ_PACK_NOT_FOUND');
    expect(manager.find).not.toHaveBeenCalled();
  });

  it('answers VJ_CLIP_NOT_FOUND for a clip gone since the write', async () => {
    const manager = buildManager();
    await expect(
      refusalCodeOf(readVjClipDto(asManager(manager), CLIP_ID)),
    ).resolves.toBe('VJ_CLIP_NOT_FOUND');
    expect(manager.findOne).toHaveBeenCalledWith(VjClip, {
      where: { id: CLIP_ID },
    });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('reads creators, pack ids and set list item counts in one query each', async () => {
    const manager = buildManager();
    manager.query
      .mockResolvedValueOnce([
        { clip_id: CLIP_ID, pack_id: PACK_ID },
        { clip_id: CLIP_ID, pack_id: OTHER_PACK_ID },
        { clip_id: OTHER_CLIP_ID, pack_id: OTHER_PACK_ID },
      ])
      .mockResolvedValueOnce([
        { clip_id: CLIP_ID, item_count: 3 },
        { clip_id: OTHER_CLIP_ID, item_count: '1' },
      ]);
    const clips = [
      buildClip(),
      buildClip({
        id: OTHER_CLIP_ID,
        createdByUserId: OTHER_ADMIN_ID,
        previewStorageKey: null,
      }),
      buildClip({ id: uuidAt(2, 3), createdByUserId: ADMIN_ID }),
    ];
    const dtos = await toVjClipDtos(asManager(manager), clips);

    expect(manager.query).toHaveBeenCalledTimes(2);
    const [, queryParameters] = manager.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(queryParameters).toEqual([[CLIP_ID, OTHER_CLIP_ID, uuidAt(2, 3)]]);
    expect(manager.query.mock.calls[1]).toEqual([
      VJ_CLIP_SETLIST_ITEM_COUNTS_SQL,
      [[CLIP_ID, OTHER_CLIP_ID, uuidAt(2, 3)]],
    ]);
    expect(dtos.map((dto) => dto.setlistItemCount)).toEqual([3, 1, 0]);
    expect(manager.find).toHaveBeenCalledTimes(1);
    const [, profileOptions] = manager.find.mock.calls[0] as [
      unknown,
      { where: { userId: FindOperator<string[]> } },
    ];
    const profileWhere = profileOptions.where.userId;
    expect(profileWhere.value).toEqual([ADMIN_ID, OTHER_ADMIN_ID]);

    expect(dtos.map((dto) => dto.packIds)).toEqual([
      [PACK_ID, OTHER_PACK_ID],
      [OTHER_PACK_ID],
      [],
    ]);
    expect(dtos[0]).toMatchObject({
      isFavorite: true,
      defaultSpeed: 1.5,
      loopInMs: 500,
      loopOutMs: 6000,
      loopMode: 'pingPong',
      previewUrl: `${API_BASE_URL}/files/${PREVIEW_KEY}`,
      createdBy: { userId: ADMIN_ID, displayName: 'Ana Lima' },
    });
    expect(dtos[1]).toMatchObject({
      previewUrl: null,
      createdBy: { userId: OTHER_ADMIN_ID, displayName: 'Rui Sousa' },
    });
  });

  it('reads nothing for empty lists', async () => {
    const manager = buildManager();
    await expect(toVjClipDtos(asManager(manager), [])).resolves.toEqual([]);
    await expect(readVjClipPackIds(asManager(manager), [])).resolves.toEqual(
      new Map(),
    );
    await expect(
      readVjClipSetlistItemCounts(asManager(manager), []),
    ).resolves.toEqual(new Map());
    await expect(
      readVjCreatorProfiles(asManager(manager), [null, null]),
    ).resolves.toEqual(new Map());
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.find).not.toHaveBeenCalled();
  });

  it('answers one clip DTO through the shared batch reads', async () => {
    const manager = buildManager();
    manager.findOne.mockResolvedValueOnce(buildClip());
    manager.query.mockResolvedValueOnce([
      { clip_id: CLIP_ID, pack_id: PACK_ID },
    ]);
    const clip = await readVjClipDto(asManager(manager), CLIP_ID);
    expect(clip).toMatchObject({
      id: CLIP_ID,
      packIds: [PACK_ID],
      packCount: 1,
      setlistItemCount: 0,
    });
    expect(JSON.stringify(clip)).not.toContain(`"${CLIP_KEY}"`);
  });

  it("counts each clip's set list items with the contract 4.1 read", async () => {
    expect(VJ_CLIP_SETLIST_ITEM_COUNTS_SQL).toBe(
      'SELECT "item"."clip_id", COUNT(*)::int AS "item_count" FROM "vj_setlist_items" "item" WHERE "item"."clip_id" = ANY($1::uuid[]) GROUP BY "item"."clip_id"',
    );
    const manager = buildManager();
    manager.query.mockResolvedValueOnce([
      { clip_id: OTHER_CLIP_ID, item_count: '4' },
    ]);
    const counts = await readVjClipSetlistItemCounts(asManager(manager), [
      CLIP_ID,
      OTHER_CLIP_ID,
    ]);
    expect(counts).toEqual(new Map([[OTHER_CLIP_ID, 4]]));
    expect(manager.query).toHaveBeenCalledWith(
      VJ_CLIP_SETLIST_ITEM_COUNTS_SQL,
      [[CLIP_ID, OTHER_CLIP_ID]],
    );
  });
});
