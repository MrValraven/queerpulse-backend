import { HttpException } from '@nestjs/common';
import type { CreateVjClipDto } from './dto/vj.dto';
import {
  countCodePoints,
  isUuidText,
  isVjDimension,
  normalizeClipCreate,
  normalizeClipUpdate,
  normalizeDurationMs,
  normalizeIdPermutation,
  normalizePackName,
  parseMediaClipIds,
} from './vj-input';

const CLIP_KEY_MP4 =
  'vj-clips/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.mp4';
const CLIP_KEY_WEBM =
  'vj-clips/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webm';
const CLIP_KEY_GIF =
  'vj-clips/11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444.gif';
const THUMBNAIL_KEY =
  'vj-thumbnails/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666.webp';
const PACK_ID = '77777777-7777-4777-8777-777777777777';

/** Runs a function and answers the `code` and extra body fields it refused with. */
function refusalOf(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse() as Record<string, unknown>;
    }
    throw error;
  }
  throw new Error('Expected a refusal, got a value');
}

function validVideoBody(): CreateVjClipDto {
  return {
    title: 'Peak hour',
    storageKey: CLIP_KEY_MP4,
    thumbnailStorageKey: THUMBNAIL_KEY,
    width: 1920,
    height: 1080,
    durationMs: 30_000,
  };
}

describe('normalizePackName', () => {
  it('checks a pack name', () => {
    for (const value of [undefined, 5, null, '   ']) {
      expect(refusalOf(() => normalizePackName(value)).code).toBe(
        'VJ_PACK_NAME_REQUIRED',
      );
    }
    expect(refusalOf(() => normalizePackName('a'.repeat(61))).code).toBe(
      'VJ_PACK_NAME_TOO_LONG',
    );
    expect(normalizePackName('🌈'.repeat(60))).toBe('🌈'.repeat(60));
    expect(normalizePackName('  Peak hour ')).toBe('Peak hour');
  });

  it('counts a code point once', () => {
    expect(countCodePoints('🌈🌈')).toBe(2);
    expect(countCodePoints('')).toBe(0);
  });
});

describe('normalizeClipCreate', () => {
  it.each([
    ['no title', { title: undefined }, 'VJ_CLIP_TITLE_REQUIRED', undefined],
    [
      'a 121 character title',
      { title: 'a'.repeat(121) },
      'VJ_CLIP_TITLE_TOO_LONG',
      undefined,
    ],
    [
      'a key of another kind as the clip key',
      { storageKey: 'avatars/x/y.jpg' },
      'VJ_CLIP_KEY_INVALID',
      'storageKey',
    ],
    [
      'a clip key as the thumbnail key',
      { thumbnailStorageKey: CLIP_KEY_MP4 },
      'VJ_CLIP_KEY_INVALID',
      'thumbnailStorageKey',
    ],
    ['a zero width', { width: 0 }, 'VJ_CLIP_DIMENSIONS_INVALID', undefined],
    [
      'a height over the cap',
      { height: 16_385 },
      'VJ_CLIP_DIMENSIONS_INVALID',
      undefined,
    ],
    [
      'a fractional width',
      { width: 1.5 },
      'VJ_CLIP_DIMENSIONS_INVALID',
      undefined,
    ],
    ['a text width', { width: '640' }, 'VJ_CLIP_DIMENSIONS_INVALID', undefined],
    [
      'a video with a null duration',
      { durationMs: null },
      'VJ_CLIP_DURATION_INVALID',
      undefined,
    ],
    [
      'a video with a zero duration',
      { durationMs: 0 },
      'VJ_CLIP_DURATION_INVALID',
      undefined,
    ],
    [
      'a video over an hour',
      { durationMs: 3_600_001 },
      'VJ_CLIP_DURATION_INVALID',
      undefined,
    ],
    [
      'a video with a fractional duration',
      { durationMs: 1.5 },
      'VJ_CLIP_DURATION_INVALID',
      undefined,
    ],
    [
      'a GIF with a duration',
      { storageKey: CLIP_KEY_GIF, durationMs: 10 },
      'VJ_CLIP_DURATION_INVALID',
      undefined,
    ],
    [
      'an unknown fit mode',
      { fitMode: 'stretch' },
      'VJ_CLIP_FIT_MODE_INVALID',
      undefined,
    ],
    [
      'a pack id that is no uuid',
      { packId: 'nope' },
      'VJ_PACK_NOT_FOUND',
      undefined,
    ],
    ['a numeric pack id', { packId: 5 }, 'VJ_PACK_NOT_FOUND', undefined],
  ])(
    'checks a clip create in the contract order: %s',
    (_label, change, code, field) => {
      const body = { ...validVideoBody(), ...change } as CreateVjClipDto;
      const refusal = refusalOf(() => normalizeClipCreate(body));
      expect(refusal.code).toBe(code);
      expect(refusal.field).toBe(field);
    },
  );

  it('answers the title code first when every field is wrong', () => {
    const body = {
      title: 5,
      storageKey: 5,
      thumbnailStorageKey: 5,
      width: 'x',
      height: 'x',
      durationMs: 'x',
      fitMode: 'x',
      packId: 5,
    } as CreateVjClipDto;
    expect(refusalOf(() => normalizeClipCreate(body)).code).toBe(
      'VJ_CLIP_TITLE_REQUIRED',
    );
  });

  it('derives the type and kind from the key and defaults the fit mode', () => {
    const webm = normalizeClipCreate({
      ...validVideoBody(),
      storageKey: CLIP_KEY_WEBM,
    });
    expect(webm.mimeType).toBe('video/webm');
    expect(webm.mediaKind).toBe('video');
    expect(webm.fitMode).toBe('fill');
    expect(webm.packId).toBeNull();

    const gif = normalizeClipCreate({
      ...validVideoBody(),
      storageKey: CLIP_KEY_GIF,
      durationMs: undefined,
      packId: null,
    });
    expect(gif.durationMs).toBeNull();
    expect(gif.mediaKind).toBe('gif');
    expect(gif.mimeType).toBe('image/gif');
    expect(gif.packId).toBeNull();
  });

  it('keeps a valid pack id and fit mode', () => {
    const normalized = normalizeClipCreate({
      ...validVideoBody(),
      title: '  Strobe  ',
      fitMode: 'fit',
      packId: PACK_ID.toUpperCase(),
    });
    expect(normalized.title).toBe('Strobe');
    expect(normalized.fitMode).toBe('fit');
    expect(normalized.packId).toBe(PACK_ID);
  });
});

describe('normalizeClipUpdate', () => {
  it('reads an update with absent fields left out', () => {
    expect(normalizeClipUpdate({})).toEqual({});
    expect(refusalOf(() => normalizeClipUpdate({ title: null })).code).toBe(
      'VJ_CLIP_TITLE_REQUIRED',
    );
    expect(normalizeClipUpdate({ fitMode: 'fit' })).toEqual({
      fitMode: 'fit',
    });
    expect(normalizeClipUpdate({ title: ' New ', fitMode: 'fill' })).toEqual({
      title: 'New',
      fitMode: 'fill',
    });
  });
});

describe('normalizeIdPermutation', () => {
  it('checks a reorder list as a permutation', () => {
    expect(
      normalizeIdPermutation(
        ['b', 'a'],
        ['a', 'b'],
        'VJ_PACK_REORDER_MISMATCH',
      ),
    ).toEqual(['b', 'a']);
    const badValues: unknown[] = [
      ['a'],
      ['a', 'a'],
      ['a', 'c'],
      'a,b',
      [1, 2],
      null,
    ];
    for (const value of badValues) {
      expect(
        refusalOf(() =>
          normalizeIdPermutation(
            value,
            ['a', 'b'],
            'VJ_PACK_CLIPS_REORDER_MISMATCH',
          ),
        ).code,
      ).toBe('VJ_PACK_CLIPS_REORDER_MISMATCH');
    }
    expect(
      refusalOf(() =>
        normalizeIdPermutation(['a'], ['a', 'b'], 'VJ_PACK_REORDER_MISMATCH'),
      ).code,
    ).toBe('VJ_PACK_REORDER_MISMATCH');
  });
});

describe('parseMediaClipIds', () => {
  it('parses media clip ids', () => {
    expect(parseMediaClipIds(undefined)).toBeNull();
    const manyIds = Array.from(
      { length: 201 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ).join(',');
    for (const value of ['', ' , ', ['a'], manyIds, 'nope']) {
      expect(refusalOf(() => parseMediaClipIds(value)).code).toBe(
        'VJ_CLIP_IDS_INVALID',
      );
    }
    expect(parseMediaClipIds(`${PACK_ID.toUpperCase()},${PACK_ID}`)).toEqual([
      PACK_ID,
    ]);
  });
});

describe('small checks', () => {
  it('accepts only whole pixel dimensions', () => {
    expect(isVjDimension(1)).toBe(true);
    expect(isVjDimension(16_384)).toBe(true);
    expect(isVjDimension(0)).toBe(false);
    expect(isVjDimension('1')).toBe(false);
  });

  it('reads a duration per kind', () => {
    expect(normalizeDurationMs('gif', undefined)).toBeNull();
    expect(normalizeDurationMs('video', 1)).toBe(1);
  });

  it('recognises uuid text', () => {
    expect(isUuidText(PACK_ID)).toBe(true);
    expect(isUuidText('nope')).toBe(false);
    expect(isUuidText(5)).toBe(false);
  });
});
