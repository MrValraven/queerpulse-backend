import { HttpException } from '@nestjs/common';
import type { CreateVjClipDto } from './dto/vj.dto';
import {
  checkVjLoopPoints,
  countCodePoints,
  isUuidText,
  isVjDimension,
  normalizeClipCreate,
  normalizeClipUpdate,
  normalizeDurationMs,
  normalizeIdPermutation,
  normalizePackName,
  normalizeSceneName,
  normalizeSetlistName,
  normalizeSetlistSceneIds,
  parseMediaClipIds,
  parseRequiredClipIds,
  readEventIdBody,
  readOptionalPackId,
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
const SCENE_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_SCENE_ID = '99999999-9999-4999-8999-999999999999';
const SETLIST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

  it('answers the scene and set list reorder codes', () => {
    expect(
      refusalOf(() =>
        normalizeIdPermutation(
          ['a', 'a'],
          ['a', 'b'],
          'VJ_SCENE_REORDER_MISMATCH',
        ),
      ).code,
    ).toBe('VJ_SCENE_REORDER_MISMATCH');
    expect(
      refusalOf(() =>
        normalizeIdPermutation([], ['a'], 'VJ_SETLIST_REORDER_MISMATCH'),
      ).code,
    ).toBe('VJ_SETLIST_REORDER_MISMATCH');
    expect(
      normalizeIdPermutation(
        ['B', 'a'],
        ['a', 'b'],
        'VJ_SETLIST_REORDER_MISMATCH',
      ),
    ).toEqual(['b', 'a']);
  });
});

describe('normalizeClipUpdate v2', () => {
  it('checks a clip update in the contract order', () => {
    expect(
      refusalOf(() => normalizeClipUpdate({ title: '', defaultSpeed: 3 })).code,
    ).toBe('VJ_CLIP_TITLE_REQUIRED');
    expect(
      refusalOf(() =>
        normalizeClipUpdate({
          fitMode: 'stretch',
          isFavorite: 'yes',
          defaultSpeed: 3,
          loopMode: 'bounce',
          loopInMs: -1,
        }),
      ).code,
    ).toBe('VJ_CLIP_FIT_MODE_INVALID');
    expect(
      refusalOf(() =>
        normalizeClipUpdate({
          isFavorite: 'yes',
          defaultSpeed: 3,
          loopMode: 'bounce',
          loopInMs: -1,
        }),
      ).code,
    ).toBe('VJ_CLIP_FAVORITE_INVALID');
    expect(
      refusalOf(() =>
        normalizeClipUpdate({
          defaultSpeed: 3,
          loopMode: 'bounce',
          loopInMs: -1,
        }),
      ).code,
    ).toBe('VJ_CLIP_SPEED_INVALID');
    expect(
      refusalOf(() => normalizeClipUpdate({ loopMode: 'bounce', loopInMs: -1 }))
        .code,
    ).toBe('VJ_CLIP_LOOP_MODE_INVALID');

    for (const defaultSpeed of [0.3, '1', null, 8]) {
      expect(refusalOf(() => normalizeClipUpdate({ defaultSpeed })).code).toBe(
        'VJ_CLIP_SPEED_INVALID',
      );
    }
    for (const loopPoint of [-1, 1.5, '10', Number.NaN, 2 ** 53]) {
      expect(
        refusalOf(() => normalizeClipUpdate({ loopInMs: loopPoint })).code,
      ).toBe('VJ_CLIP_LOOP_INVALID');
      expect(
        refusalOf(() => normalizeClipUpdate({ loopOutMs: loopPoint })).code,
      ).toBe('VJ_CLIP_LOOP_INVALID');
    }
    for (const isFavorite of ['true', 1, null]) {
      expect(refusalOf(() => normalizeClipUpdate({ isFavorite })).code).toBe(
        'VJ_CLIP_FAVORITE_INVALID',
      );
    }
    expect(refusalOf(() => normalizeClipUpdate({ loopMode: null })).code).toBe(
      'VJ_CLIP_LOOP_MODE_INVALID',
    );
  });

  it('reads every v2 field and leaves absent ones out', () => {
    expect(
      normalizeClipUpdate({
        isFavorite: false,
        defaultSpeed: 0.25,
        loopMode: 'pingPong',
        loopInMs: 0,
        loopOutMs: null,
      }),
    ).toEqual({
      isFavorite: false,
      defaultSpeed: 0.25,
      loopMode: 'pingPong',
      loopInMs: 0,
      loopOutMs: null,
    });
    expect(normalizeClipUpdate({ loopOutMs: 1200 })).toEqual({
      loopOutMs: 1200,
    });
  });
});

describe('checkVjLoopPoints', () => {
  const video = { mediaKind: 'video' as const, durationMs: 10_000 };
  const gif = { mediaKind: 'gif' as const, durationMs: null };

  it('checks merged loop points against the clip', () => {
    const refusedCases: Array<
      [
        { mediaKind: 'video' | 'gif'; durationMs: number | null },
        number | null,
        number | null,
      ]
    > = [
      [gif, 0, null],
      [gif, null, 500],
      [video, null, 10_001],
      [video, 10_001, null],
      [video, 1000, 1249],
      [video, 9800, null],
      [video, null, 249],
      [video, 2000, 1000],
      [video, -1, null],
      [{ mediaKind: 'video', durationMs: null }, 0, null],
    ];
    for (const [clip, loopInMs, loopOutMs] of refusedCases) {
      expect(
        refusalOf(() => checkVjLoopPoints(clip, loopInMs, loopOutMs)).code,
      ).toBe('VJ_CLIP_LOOP_INVALID');
    }
  });

  it('passes both points cleared on any clip, and in or out alone', () => {
    expect(() =>
      checkVjLoopPoints({ mediaKind: 'video', durationMs: 100 }, null, null),
    ).not.toThrow();
    expect(() => checkVjLoopPoints(gif, null, null)).not.toThrow();
    expect(() => checkVjLoopPoints(video, 9750, null)).not.toThrow();
    expect(() => checkVjLoopPoints(video, null, 250)).not.toThrow();
    expect(() => checkVjLoopPoints(video, 1000, 1250)).not.toThrow();
    expect(() => checkVjLoopPoints(video, 0, 10_000)).not.toThrow();
  });
});

describe('scene and set list names', () => {
  it('reads scene and set list names', () => {
    for (const value of [undefined, 5, null, '   ']) {
      expect(refusalOf(() => normalizeSceneName(value)).code).toBe(
        'VJ_SCENE_NAME_REQUIRED',
      );
      expect(refusalOf(() => normalizeSetlistName(value)).code).toBe(
        'VJ_SETLIST_NAME_REQUIRED',
      );
    }
    expect(refusalOf(() => normalizeSceneName('a'.repeat(61))).code).toBe(
      'VJ_SCENE_NAME_TOO_LONG',
    );
    expect(refusalOf(() => normalizeSetlistName('a'.repeat(61))).code).toBe(
      'VJ_SETLIST_NAME_TOO_LONG',
    );
    expect(normalizeSceneName('🌈'.repeat(60))).toBe('🌈'.repeat(60));
    expect(normalizeSceneName('  Glow up ')).toBe('Glow up');
    expect(normalizeSetlistName(' Friday ')).toBe('Friday');
  });

  it('keeps refusal messages free of the name it read', () => {
    const name = 'Secret warehouse set';
    const refusal = refusalOf(() => normalizeSceneName(name.repeat(4)));
    expect(JSON.stringify(refusal)).not.toContain('warehouse');
  });
});

describe('readOptionalPackId', () => {
  it('reads an optional pack id', () => {
    expect(readOptionalPackId(undefined)).toBeUndefined();
    expect(readOptionalPackId(null)).toBeNull();
    expect(readOptionalPackId(PACK_ID.toUpperCase())).toBe(PACK_ID);
    for (const value of ['nope', 5, '', [PACK_ID]]) {
      expect(refusalOf(() => readOptionalPackId(value)).code).toBe(
        'VJ_PACK_NOT_FOUND',
      );
    }
  });
});

describe('readEventIdBody', () => {
  it('reads an event id body', () => {
    expect(readEventIdBody(null)).toBeNull();
    expect(readEventIdBody(PACK_ID.toUpperCase())).toBe(PACK_ID);
    for (const value of [undefined, 'nope', 5, '', {}]) {
      expect(refusalOf(() => readEventIdBody(value)).code).toBe(
        'VJ_EVENT_NOT_FOUND',
      );
    }
  });
});

describe('parseRequiredClipIds', () => {
  it('requires clip ids on the media list and keeps their order', () => {
    for (const value of [undefined, '', ' , ', ['a'], 'nope', 5]) {
      expect(refusalOf(() => parseRequiredClipIds(value)).code).toBe(
        'VJ_CLIP_IDS_INVALID',
      );
    }
    expect(
      parseRequiredClipIds(`${SCENE_ID},${PACK_ID.toUpperCase()},${SCENE_ID}`),
    ).toEqual([SCENE_ID, PACK_ID]);
    const manyIds = Array.from(
      { length: 201 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ).join(',');
    expect(refusalOf(() => parseRequiredClipIds(manyIds)).code).toBe(
      'VJ_CLIP_IDS_INVALID',
    );
  });
});

describe('normalizeSetlistSceneIds', () => {
  it('reads set list scene ids with repeats and caps them at 100', () => {
    expect(normalizeSetlistSceneIds([], null)).toEqual([]);
    expect(
      normalizeSetlistSceneIds(
        [SCENE_ID.toUpperCase(), OTHER_SCENE_ID, SCENE_ID],
        SETLIST_ID,
      ),
    ).toEqual([SCENE_ID, OTHER_SCENE_ID, SCENE_ID]);
    for (const value of [undefined, null, 'a,b', [SCENE_ID, 5], ['nope']]) {
      expect(refusalOf(() => normalizeSetlistSceneIds(value, null)).code).toBe(
        'VJ_SETLIST_ITEMS_INVALID',
      );
    }
    const hundred = Array.from({ length: 100 }, () => SCENE_ID);
    expect(normalizeSetlistSceneIds(hundred, SETLIST_ID)).toHaveLength(100);
    const tooMany = [...hundred, SCENE_ID];
    const refusal = refusalOf(() =>
      normalizeSetlistSceneIds(tooMany, SETLIST_ID),
    );
    expect(refusal.code).toBe('VJ_SETLIST_FULL');
    expect(refusal.setlistId).toBe(SETLIST_ID);
    const createRefusal = refusalOf(() =>
      normalizeSetlistSceneIds(tooMany, null),
    );
    expect(createRefusal.code).toBe('VJ_SETLIST_FULL');
    expect(createRefusal).not.toHaveProperty('setlistId');
  });

  it('answers the items code before the full code', () => {
    const mixed = [...Array.from({ length: 101 }, () => SCENE_ID), 'nope'];
    expect(
      refusalOf(() => normalizeSetlistSceneIds(mixed, SETLIST_ID)).code,
    ).toBe('VJ_SETLIST_ITEMS_INVALID');
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
