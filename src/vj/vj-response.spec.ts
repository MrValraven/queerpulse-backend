import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { createVjStageState, vjSceneLookOf } from './vj.contract';
import {
  isVjEventListed,
  toVjClip,
  toVjClipMedia,
  toVjCreator,
  toVjEventCard,
  toVjEventOption,
  toVjPack,
  toVjPackEventSummary,
  toVjScene,
  toVjSetlist,
  toVjStepDuration,
  vjEventCardUnavailableReason,
  type VjClipRow,
  type VjCreatorProfileRow,
  type VjEventRow,
  type VjPackEventRow,
  type VjPackSummaryRow,
  type VjSceneRow,
  type VjSetlistItemRow,
  type VjSetlistRow,
} from './vj-response';

const CLIP_KEY =
  'vj-clips/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.mp4';
const THUMBNAIL_KEY =
  'vj-thumbnails/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666.webp';
const PREVIEW_KEY =
  'vj-previews/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.webm';
const CLIP_ID = '88888888-8888-4888-8888-888888888888';
const PACK_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_PACK_ID = '99999999-9999-4999-8999-999999999999';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCENE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_SCENE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SETLIST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ITEM_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SECOND_ITEM_ID = '12121212-1212-4212-8212-121212121212';

const CREATED_AT = new Date('2026-11-05T10:00:00.000Z');
const UPDATED_AT = new Date('2026-11-05T11:30:00.000Z');
const EVENT_START = new Date('2026-12-01T21:00:00.000Z');
const EVENT_END = new Date('2026-12-02T03:00:00.000Z');

function profiles(
  firstName = 'Ana',
  lastName = 'Silva',
): Map<string, VjCreatorProfileRow> {
  return new Map([[ADMIN_ID, { userId: ADMIN_ID, firstName, lastName }]]);
}

function clipRow(overrides: Partial<VjClipRow> = {}): VjClipRow {
  return {
    id: CLIP_ID,
    title: 'Peak hour',
    mediaKind: 'video',
    mimeType: 'video/mp4',
    byteSize: 5_000_000,
    width: 1920,
    height: 1080,
    durationMs: 30_000,
    storageKey: CLIP_KEY,
    thumbnailStorageKey: THUMBNAIL_KEY,
    fitMode: 'fill',
    createdByUserId: ADMIN_ID,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    isFavorite: true,
    defaultSpeed: 0.5,
    loopInMs: 1000,
    loopOutMs: 9000,
    loopMode: 'pingPong',
    previewStorageKey: PREVIEW_KEY,
    ...overrides,
  };
}

function packRow(overrides: Partial<VjPackSummaryRow> = {}): VjPackSummaryRow {
  return {
    id: PACK_ID,
    name: 'Peak hour',
    position: 2,
    createdByUserId: ADMIN_ID,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    clipCount: 3,
    totalByteSize: 15_000_000,
    coverThumbnailKey: THUMBNAIL_KEY,
    ...overrides,
  };
}

function packEventRow(overrides: Partial<VjPackEventRow> = {}): VjPackEventRow {
  return {
    id: EVENT_ID,
    title: 'Winter ball',
    startAt: EVENT_START,
    status: 'published',
    visibility: 'members',
    ...overrides,
  };
}

function eventRow(overrides: Partial<VjEventRow> = {}): VjEventRow {
  return {
    id: EVENT_ID,
    title: 'Winter ball',
    slug: 'slug-1',
    startAt: EVENT_START,
    endAt: EVENT_END,
    timezone: 'Europe/Lisbon',
    neighbourhood: 'Intendente',
    isOnline: false,
    status: 'published',
    visibility: 'public',
    ...overrides,
  };
}

describe('VJ response mappers', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('maps a clip with its v2 defaults and preview URL', () => {
    const dto = toVjClip(clipRow(), [PACK_ID, SECOND_PACK_ID], 3, profiles());
    expect(dto).toEqual({
      id: CLIP_ID,
      title: 'Peak hour',
      mediaKind: 'video',
      mimeType: 'video/mp4',
      byteSize: 5_000_000,
      width: 1920,
      height: 1080,
      durationMs: 30_000,
      fitMode: 'fill',
      thumbnailUrl: `https://api.test/files/${THUMBNAIL_KEY}`,
      mediaUrl: `https://api.test/files/${CLIP_KEY}`,
      packIds: [PACK_ID, SECOND_PACK_ID],
      packCount: 2,
      setlistItemCount: 3,
      createdBy: { userId: ADMIN_ID, displayName: 'Ana Silva' },
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T11:30:00.000Z',
      isFavorite: true,
      defaultSpeed: 0.5,
      loopInMs: 1000,
      loopOutMs: 9000,
      loopMode: 'pingPong',
      previewUrl: `https://api.test/files/${PREVIEW_KEY}`,
    });
    const keys = Object.keys(dto);
    expect(keys).not.toContain('storageKey');
    expect(keys).not.toContain('thumbnailStorageKey');
    expect(keys).not.toContain('previewStorageKey');
    const json = JSON.stringify(dto);
    expect(json).not.toContain('"vj-clips/');
    expect(json).not.toContain('"vj-thumbnails/');
    expect(json).not.toContain('"vj-previews/');

    const withoutPreview = toVjClip(
      clipRow({ previewStorageKey: null }),
      [],
      0,
      profiles(),
    );
    expect(withoutPreview.previewUrl).toBeNull();
    expect(withoutPreview.setlistItemCount).toBe(0);
  });

  it('names the creator from the profile and answers null without one', () => {
    expect(toVjCreator(ADMIN_ID, profiles('Ana', ''))).toEqual({
      userId: ADMIN_ID,
      displayName: 'Ana',
    });
    expect(toVjCreator(null, profiles())).toBeNull();
    expect(toVjCreator(ADMIN_ID, new Map())).toBeNull();
    expect(
      toVjClip(clipRow({ createdByUserId: null }), [], 0, profiles()).createdBy,
    ).toBeNull();
  });

  it('maps a pack summary with its cover and totals', () => {
    expect(toVjPack(packRow(), profiles())).toEqual({
      id: PACK_ID,
      name: 'Peak hour',
      position: 2,
      clipCount: 3,
      totalByteSize: 15_000_000,
      coverThumbnailUrl: `https://api.test/files/${THUMBNAIL_KEY}`,
      createdBy: { userId: ADMIN_ID, displayName: 'Ana Silva' },
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T11:30:00.000Z',
      event: null,
    });
    const empty = toVjPack(
      packRow({ coverThumbnailKey: null, clipCount: 0, totalByteSize: 0 }),
      profiles(),
    );
    expect(empty.coverThumbnailUrl).toBeNull();
    expect(empty.clipCount).toBe(0);
    expect(empty.totalByteSize).toBe(0);
  });

  it('adds the event summary to a pack and defaults it to null', () => {
    const summary = toVjPackEventSummary(packEventRow());
    expect(summary).toEqual({
      id: EVENT_ID,
      title: 'Winter ball',
      startAt: '2026-12-01T21:00:00.000Z',
      isAvailable: true,
    });
    expect(toVjPack(packRow(), profiles(), summary).event).toEqual(summary);
    expect(toVjPack(packRow(), profiles()).event).toBeNull();
    expect(toVjPackEventSummary(null)).toBeNull();
  });

  it('marks an event available only when published and public or members', () => {
    expect(isVjEventListed({ status: 'published', visibility: 'public' })).toBe(
      true,
    );
    expect(
      isVjEventListed({ status: 'published', visibility: 'members' }),
    ).toBe(true);
    const unavailableRows: Partial<VjPackEventRow>[] = [
      { status: 'cancelled' },
      { status: 'draft' },
      { visibility: 'invite_only' },
      { visibility: 'network' },
      { visibility: 'community' },
    ];
    for (const overrides of unavailableRows) {
      expect(toVjPackEventSummary(packEventRow(overrides))?.isAvailable).toBe(
        false,
      );
    }
  });

  it('maps an event option with its area', () => {
    expect(toVjEventOption(eventRow())).toEqual({
      id: EVENT_ID,
      title: 'Winter ball',
      startAt: '2026-12-01T21:00:00.000Z',
      endAt: '2026-12-02T03:00:00.000Z',
      area: 'Intendente',
      isOnline: false,
    });
    const openEnded = toVjEventOption(
      eventRow({ endAt: null, neighbourhood: null, isOnline: true }),
    );
    expect(openEnded.endAt).toBeNull();
    expect(openEnded.area).toBeNull();
    expect(openEnded.isOnline).toBe(true);
  });

  it('builds an event card field by field and leaves the host and address out', () => {
    const card = toVjEventCard(
      eventRow(),
      'https://queerpulse.test',
      '/gatherings/slug-1',
    );
    expect(card).toEqual({
      eventId: EVENT_ID,
      title: 'Winter ball',
      startAt: '2026-12-01T21:00:00.000Z',
      endAt: '2026-12-02T03:00:00.000Z',
      timezone: 'Europe/Lisbon',
      area: 'Intendente',
      isOnline: false,
      publicUrl: 'https://queerpulse.test/gatherings/slug-1',
    });
    expect(Object.keys(card).sort()).toEqual([
      'area',
      'endAt',
      'eventId',
      'isOnline',
      'publicUrl',
      'startAt',
      'timezone',
      'title',
    ]);
    expect(
      toVjEventCard(
        eventRow(),
        'https://queerpulse.test/',
        '/gatherings/slug-1',
      ).publicUrl,
    ).toBe('https://queerpulse.test/gatherings/slug-1');
    expect(
      toVjEventCard(eventRow(), '', '/gatherings/slug-1').publicUrl,
    ).toBeNull();
    expect(
      toVjEventCard(eventRow(), undefined, '/gatherings/slug-1').publicUrl,
    ).toBeNull();
  });

  it('names why a card is unavailable', () => {
    expect(
      vjEventCardUnavailableReason(
        eventRow({ status: 'cancelled', visibility: 'public' }),
      ),
    ).toBe('cancelled');
    expect(
      vjEventCardUnavailableReason(
        eventRow({ status: 'cancelled', visibility: 'invite_only' }),
      ),
    ).toBe('cancelled');
    expect(vjEventCardUnavailableReason(eventRow({ status: 'draft' }))).toBe(
      'not_listed',
    );
    expect(
      vjEventCardUnavailableReason(eventRow({ visibility: 'invite_only' })),
    ).toBe('not_listed');
    expect(vjEventCardUnavailableReason(eventRow())).toBeNull();
    expect(
      vjEventCardUnavailableReason(eventRow({ visibility: 'members' })),
    ).toBeNull();
  });

  it('maps scenes and set lists with their creators', () => {
    const look = vjSceneLookOf(createVjStageState('epoch-1', 1000));
    const sceneRow: VjSceneRow = {
      id: SCENE_ID,
      name: 'Opening',
      packId: PACK_ID,
      position: 0,
      createdByUserId: ADMIN_ID,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };
    expect(toVjScene(sceneRow, look, 2, profiles())).toEqual({
      id: SCENE_ID,
      name: 'Opening',
      packId: PACK_ID,
      position: 0,
      look,
      setlistItemCount: 2,
      createdBy: { userId: ADMIN_ID, displayName: 'Ana Silva' },
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T11:30:00.000Z',
    });
    expect(
      toVjScene({ ...sceneRow, createdByUserId: null }, look, 0, profiles())
        .createdBy,
    ).toBeNull();

    const setlistRow: VjSetlistRow = {
      id: SETLIST_ID,
      name: 'Saturday',
      position: 1,
      isLooping: true,
      stepDurationKind: 'beats',
      stepDurationValue: 16,
      createdByUserId: ADMIN_ID,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    };
    const items: VjSetlistItemRow[] = [
      {
        id: SECOND_ITEM_ID,
        position: 0,
        kind: 'scene',
        sceneId: SECOND_SCENE_ID,
        clipId: null,
        durationKind: null,
        durationValue: null,
      },
      {
        id: ITEM_ID,
        position: 1,
        kind: 'clip',
        sceneId: null,
        clipId: CLIP_ID,
        durationKind: 'seconds',
        durationValue: 12,
      },
    ];
    const setlist = toVjSetlist(setlistRow, items, profiles());
    expect(setlist).toEqual({
      id: SETLIST_ID,
      name: 'Saturday',
      position: 1,
      isLooping: true,
      stepDuration: { kind: 'beats', value: 16 },
      items: [
        {
          id: SECOND_ITEM_ID,
          position: 0,
          kind: 'scene',
          sceneId: SECOND_SCENE_ID,
          clipId: null,
          duration: null,
        },
        {
          id: ITEM_ID,
          position: 1,
          kind: 'clip',
          sceneId: null,
          clipId: CLIP_ID,
          duration: { kind: 'seconds', value: 12 },
        },
      ],
      createdBy: { userId: ADMIN_ID, displayName: 'Ana Silva' },
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T11:30:00.000Z',
    });
    expect(setlist.items[0]).not.toBe(items[0]);
    expect(
      toVjSetlist({ ...setlistRow, createdByUserId: null }, [], new Map()),
    ).toMatchObject({ items: [], createdBy: null });
  });

  it('maps a stored step length pair, null when either half is null', () => {
    expect(toVjStepDuration('beats', 32)).toEqual({ kind: 'beats', value: 32 });
    expect(toVjStepDuration('seconds', 8)).toEqual({
      kind: 'seconds',
      value: 8,
    });
    expect(toVjStepDuration(null, null)).toBeNull();
    expect(toVjStepDuration('seconds', null)).toBeNull();
    expect(toVjStepDuration(null, 8)).toBeNull();
  });

  it('maps a media item', () => {
    const media = toVjClipMedia(clipRow(), {
      url: 'https://bucket.test/signed',
      expiresAt: '2026-11-05T12:00:00.000Z',
    });
    expect(media).toEqual({
      clipId: CLIP_ID,
      url: 'https://bucket.test/signed',
      expiresAt: '2026-11-05T12:00:00.000Z',
      mimeType: 'video/mp4',
      byteSize: 5_000_000,
    });
    expect(Object.keys(media).sort()).toEqual([
      'byteSize',
      'clipId',
      'expiresAt',
      'mimeType',
      'url',
    ]);
  });
});
