import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import type { VjClip } from './entities/vj-clip.entity';
import {
  toVjClip,
  toVjClipMedia,
  toVjCreator,
  toVjPack,
  type VjCreatorProfileRow,
  type VjPackSummaryRow,
} from './vj-response';

const CLIP_KEY =
  'vj-clips/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.mp4';
const THUMBNAIL_KEY =
  'vj-thumbnails/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666.webp';
const CLIP_ID = '88888888-8888-4888-8888-888888888888';
const PACK_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_PACK_ID = '99999999-9999-4999-8999-999999999999';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CREATED_AT = new Date('2026-11-05T10:00:00.000Z');
const UPDATED_AT = new Date('2026-11-05T11:30:00.000Z');

function profiles(
  firstName = 'Ana',
  lastName = 'Silva',
): Map<string, VjCreatorProfileRow> {
  return new Map([[ADMIN_ID, { userId: ADMIN_ID, firstName, lastName }]]);
}

function clipRow(): VjClip {
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
    createdBy: null,
    packClips: [],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
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

describe('VJ response mappers', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('maps a clip with URLs only', () => {
    const dto = toVjClip(clipRow(), [PACK_ID, SECOND_PACK_ID], profiles());
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
      createdBy: { userId: ADMIN_ID, displayName: 'Ana Silva' },
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T11:30:00.000Z',
    });
    const keys = Object.keys(dto);
    expect(keys).not.toContain('storageKey');
    expect(keys).not.toContain('thumbnailStorageKey');
  });

  it('names the creator from the profile and answers null without one', () => {
    expect(toVjCreator(ADMIN_ID, profiles('Ana', ''))).toEqual({
      userId: ADMIN_ID,
      displayName: 'Ana',
    });
    expect(toVjCreator(null, profiles())).toBeNull();
    expect(toVjCreator(ADMIN_ID, new Map())).toBeNull();
    expect(
      toVjClip({ ...clipRow(), createdByUserId: null }, [], profiles())
        .createdBy,
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
    });
    const empty = toVjPack(
      packRow({ coverThumbnailKey: null, clipCount: 0, totalByteSize: 0 }),
      profiles(),
    );
    expect(empty.coverThumbnailUrl).toBeNull();
    expect(empty.clipCount).toBe(0);
    expect(empty.totalByteSize).toBe(0);
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
