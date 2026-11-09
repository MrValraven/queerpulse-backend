import { createVjStageState, VJ_SOCKET_ERROR_CODES } from './vj.contract';
import {
  VJ_REFUSAL_CODES,
  VJ_REFUSALS,
  VJ_SOCKET_ERROR_MESSAGES,
  vjAckFailure,
  vjError,
  type VjErrorOptions,
} from './vj.constants';

const PACK_ID = '5b0c8d2e-4f1a-4c3b-9d7e-2a6f8b1c0d3e';
const SETLIST_ID = '7d2e4f6a-8b1c-4d3e-9f5a-6b7c8d9e0f1a';
const SCENE_ID = '9f1a2b3c-4d5e-4f6a-8b7c-0d1e2f3a4b5c';
const LOOK_FIELD = 'effects.settings.kaleidoscope.variant';

/** En and em dash, built from char codes so the source holds neither. */
const LONG_DASH_PATTERN = new RegExp(
  `[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`,
);

/** Every option set at once, so each case shows which extras a code keeps. */
const EVERY_OPTION: VjErrorOptions = {
  field: 'previewStorageKey',
  packId: PACK_ID,
  kind: 'vj_preview',
  maxBytes: 524288,
  setlistId: SETLIST_ID,
  sceneId: SCENE_ID,
  lookField: LOOK_FIELD,
};

describe('vjError', () => {
  it.each([
    ['VJ_PACK_NOT_FOUND', 404],
    ['VJ_PACK_NAME_REQUIRED', 400],
    ['VJ_PACK_NAME_TOO_LONG', 400],
    ['VJ_PACK_NAME_TAKEN', 409],
    ['VJ_PACK_LIMIT_REACHED', 409],
    ['VJ_PACK_REORDER_MISMATCH', 400],
    ['VJ_PACK_FULL', 409],
    ['VJ_PACK_CLIPS_REORDER_MISMATCH', 400],
    ['VJ_CLIP_NOT_FOUND', 404],
    ['VJ_CLIP_ALREADY_IN_PACK', 409],
    ['VJ_CLIP_NOT_IN_PACK', 404],
    ['VJ_CLIP_TITLE_REQUIRED', 400],
    ['VJ_CLIP_TITLE_TOO_LONG', 400],
    ['VJ_CLIP_FIT_MODE_INVALID', 400],
    ['VJ_CLIP_DIMENSIONS_INVALID', 400],
    ['VJ_CLIP_DURATION_INVALID', 400],
    ['VJ_CLIP_KEY_INVALID', 400],
    ['VJ_CLIP_KEY_IN_USE', 409],
    ['VJ_CLIP_IDS_INVALID', 400],
    ['VJ_LIBRARY_FULL', 409],
    ['VJ_UPLOAD_NOT_ADMIN', 403],
    ['VJ_UPLOAD_TYPE_UNSUPPORTED', 400],
    ['VJ_UPLOAD_TOO_LARGE', 413],
    ['VJ_UPLOAD_FORMAT_MOV', 400],
    ['VJ_UPLOAD_CONTENT_MISMATCH', 400],
    ['VJ_UPLOAD_MISSING', 409],
    ['VJ_CLIP_FAVORITE_INVALID', 400],
    ['VJ_CLIP_SPEED_INVALID', 400],
    ['VJ_CLIP_LOOP_MODE_INVALID', 400],
    ['VJ_CLIP_LOOP_INVALID', 400],
    ['VJ_EVENT_NOT_FOUND', 404],
    ['VJ_EVENT_NOT_LINKABLE', 409],
    ['VJ_SCENE_NOT_FOUND', 404],
    ['VJ_SCENE_NAME_REQUIRED', 400],
    ['VJ_SCENE_NAME_TOO_LONG', 400],
    ['VJ_SCENE_LIMIT_REACHED', 409],
    ['VJ_SCENE_LOOK_INVALID', 400],
    ['VJ_SCENE_CLIP_NOT_FOUND', 404],
    ['VJ_SCENE_REORDER_MISMATCH', 400],
    ['VJ_SETLIST_NOT_FOUND', 404],
    ['VJ_SETLIST_NAME_REQUIRED', 400],
    ['VJ_SETLIST_NAME_TOO_LONG', 400],
    ['VJ_SETLIST_NAME_TAKEN', 409],
    ['VJ_SETLIST_LIMIT_REACHED', 409],
    ['VJ_SETLIST_REORDER_MISMATCH', 400],
    ['VJ_SETLIST_ITEMS_INVALID', 400],
    ['VJ_SETLIST_FULL', 409],
    ['VJ_CONNECTION_NOT_FOUND', 404],
    ['VJ_CONNECTION_NOT_YOURS', 403],
  ] as const)(
    'answers %s with status %i and the code in the body',
    (code, status) => {
      const error = vjError(code);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        message: VJ_REFUSALS[code].message,
        code,
      });
    },
  );

  it('lists the 49 server codes in contract order', () => {
    expect(VJ_REFUSAL_CODES).toHaveLength(49);
    expect(VJ_REFUSAL_CODES[0]).toBe('VJ_PACK_NOT_FOUND');
    expect(VJ_REFUSAL_CODES[25]).toBe('VJ_UPLOAD_MISSING');
    expect(VJ_REFUSAL_CODES[26]).toBe('VJ_CLIP_FAVORITE_INVALID');
    expect(VJ_REFUSAL_CODES[46]).toBe('VJ_SETLIST_FULL');
    expect(VJ_REFUSAL_CODES[47]).toBe('VJ_CONNECTION_NOT_FOUND');
    expect(VJ_REFUSAL_CODES[48]).toBe('VJ_CONNECTION_NOT_YOURS');
    expect(Object.keys(VJ_REFUSALS)).toEqual([...VJ_REFUSAL_CODES]);
  });

  it('copies only the extras listed for the code', () => {
    expect(
      vjError('VJ_SCENE_LOOK_INVALID', EVERY_OPTION).getResponse(),
    ).toEqual({
      statusCode: 400,
      message: VJ_REFUSALS.VJ_SCENE_LOOK_INVALID.message,
      code: 'VJ_SCENE_LOOK_INVALID',
      lookField: LOOK_FIELD,
    });
    expect(
      vjError('VJ_SCENE_CLIP_NOT_FOUND', EVERY_OPTION).getResponse(),
    ).toEqual({
      statusCode: 404,
      message: VJ_REFUSALS.VJ_SCENE_CLIP_NOT_FOUND.message,
      code: 'VJ_SCENE_CLIP_NOT_FOUND',
      lookField: LOOK_FIELD,
    });
    expect(vjError('VJ_SETLIST_FULL', EVERY_OPTION).getResponse()).toEqual({
      statusCode: 409,
      message: VJ_REFUSALS.VJ_SETLIST_FULL.message,
      code: 'VJ_SETLIST_FULL',
      setlistId: SETLIST_ID,
    });
    expect(
      vjError('VJ_SETLIST_NAME_TAKEN', EVERY_OPTION).getResponse(),
    ).toEqual({
      statusCode: 409,
      message: VJ_REFUSALS.VJ_SETLIST_NAME_TAKEN.message,
      code: 'VJ_SETLIST_NAME_TAKEN',
      setlistId: SETLIST_ID,
    });
    expect(vjError('VJ_SCENE_NOT_FOUND', EVERY_OPTION).getResponse()).toEqual({
      statusCode: 404,
      message: VJ_REFUSALS.VJ_SCENE_NOT_FOUND.message,
      code: 'VJ_SCENE_NOT_FOUND',
      sceneId: SCENE_ID,
    });
    expect(vjError('VJ_UPLOAD_TOO_LARGE', EVERY_OPTION).getResponse()).toEqual({
      statusCode: 413,
      message: VJ_REFUSALS.VJ_UPLOAD_TOO_LARGE.message,
      code: 'VJ_UPLOAD_TOO_LARGE',
      kind: 'vj_preview',
      maxBytes: 524288,
      field: 'previewStorageKey',
    });
    expect(vjError('VJ_PACK_FULL', EVERY_OPTION).getResponse()).toEqual({
      statusCode: 409,
      message: VJ_REFUSALS.VJ_PACK_FULL.message,
      code: 'VJ_PACK_FULL',
      packId: PACK_ID,
    });
    expect(
      vjError('VJ_UPLOAD_TYPE_UNSUPPORTED', EVERY_OPTION).getResponse(),
    ).toEqual({
      statusCode: 400,
      message: VJ_REFUSALS.VJ_UPLOAD_TYPE_UNSUPPORTED.message,
      code: 'VJ_UPLOAD_TYPE_UNSUPPORTED',
      kind: 'vj_preview',
    });
    expect(vjError('VJ_CLIP_KEY_IN_USE', EVERY_OPTION).getResponse()).toEqual({
      statusCode: 409,
      message: VJ_REFUSALS.VJ_CLIP_KEY_IN_USE.message,
      code: 'VJ_CLIP_KEY_IN_USE',
      field: 'previewStorageKey',
    });
    for (const code of [
      'VJ_PACK_NOT_FOUND',
      'VJ_EVENT_NOT_LINKABLE',
      'VJ_SETLIST_NOT_FOUND',
      'VJ_CLIP_LOOP_INVALID',
      'VJ_SETLIST_ITEMS_INVALID',
    ] as const) {
      expect(vjError(code, EVERY_OPTION).getResponse()).toEqual({
        statusCode: VJ_REFUSALS[code].status,
        message: VJ_REFUSALS[code].message,
        code,
      });
    }
  });

  it('leaves out an extra whose option is undefined', () => {
    expect(
      vjError('VJ_UPLOAD_TOO_LARGE', {
        kind: 'vj_thumbnail',
        maxBytes: 262144,
      }).getResponse(),
    ).toEqual({
      statusCode: 413,
      message: VJ_REFUSALS.VJ_UPLOAD_TOO_LARGE.message,
      code: 'VJ_UPLOAD_TOO_LARGE',
      kind: 'vj_thumbnail',
      maxBytes: 262144,
    });
    expect(vjError('VJ_SCENE_NOT_FOUND').getResponse()).toEqual({
      statusCode: 404,
      message: VJ_REFUSALS.VJ_SCENE_NOT_FOUND.message,
      code: 'VJ_SCENE_NOT_FOUND',
    });
  });

  it('keeps every message a fixed sentence', () => {
    const sceneName = 'Secret scene name';
    const setlistName = 'Secret set list name';
    const lookJson = '{"effects":{"settings":{"hue":{"isOn":true}}}}';
    const previewKey = 'vj-previews/abc/def.webm';
    const strayOptions = {
      ...EVERY_OPTION,
      title: 'Secret title',
      name: sceneName,
      setlistName,
      look: lookJson,
      storageKey: previewKey,
    } as unknown as VjErrorOptions;
    for (const code of VJ_REFUSAL_CODES) {
      const body = vjError(code, strayOptions).getResponse() as Record<
        string,
        unknown
      >;
      const message = body.message as string;
      for (const forbidden of [
        PACK_ID,
        SETLIST_ID,
        SCENE_ID,
        LOOK_FIELD,
        'Secret title',
        sceneName,
        setlistName,
        lookJson,
        previewKey,
        'vj-clips/',
        'vj-previews/',
      ]) {
        expect(message).not.toContain(forbidden);
      }
      expect(body).not.toHaveProperty('title');
      expect(body).not.toHaveProperty('name');
      expect(body).not.toHaveProperty('setlistName');
      expect(body).not.toHaveProperty('look');
      expect(body).not.toHaveProperty('storageKey');
      expect(message).not.toMatch(LONG_DASH_PATTERN);
    }
    expect(
      new Set(Object.values(VJ_REFUSALS).map(({ message }) => message)).size,
    ).toBe(47);
  });
});

describe('vjAckFailure', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('builds socket failures with serverNow and an optional state', () => {
    jest.useFakeTimers().setSystemTime(5000);

    const withoutState = vjAckFailure('vj_mix_empty');
    expect(withoutState).toEqual({
      ok: false,
      code: 'vj_mix_empty',
      message: VJ_SOCKET_ERROR_MESSAGES.vj_mix_empty,
      serverNow: 5000,
    });
    expect(withoutState).not.toHaveProperty('state');

    const state = createVjStageState('epoch-1', 1000);
    expect(vjAckFailure('vj_stale_setlist', state)).toEqual({
      ok: false,
      code: 'vj_stale_setlist',
      message: VJ_SOCKET_ERROR_MESSAGES.vj_stale_setlist,
      serverNow: 5000,
      state,
    });
  });

  it('holds one distinct fixed sentence per socket code', () => {
    expect(Object.keys(VJ_SOCKET_ERROR_MESSAGES)).toHaveLength(75);
    expect(Object.keys(VJ_SOCKET_ERROR_MESSAGES).sort()).toEqual(
      [...VJ_SOCKET_ERROR_CODES].sort(),
    );
    expect(new Set(Object.values(VJ_SOCKET_ERROR_MESSAGES)).size).toBe(75);
    for (const message of Object.values(VJ_SOCKET_ERROR_MESSAGES)) {
      expect(message).not.toMatch(LONG_DASH_PATTERN);
    }
  });

  it('rewrites the two v1 sentences the v2 catalog changed', () => {
    expect(VJ_SOCKET_ERROR_MESSAGES.vj_transition_mode_invalid).toBe(
      'The transition mode is outside the catalog.',
    );
    expect(VJ_SOCKET_ERROR_MESSAGES.vj_speed_invalid).toBe(
      'The speed must be 0.25, 0.5, 1, 1.5, 2 or 4.',
    );
  });

  it('names the transition length, overlay style list and excluded ids array', () => {
    expect(VJ_SOCKET_ERROR_MESSAGES.vj_fade_out_of_range).toBe(
      'A transition length in milliseconds must be a whole number from 0 to 4000.',
    );
    expect(VJ_SOCKET_ERROR_MESSAGES.vj_overlay_style_invalid).toBe(
      'The overlay style is outside the list.',
    );
    expect(VJ_SOCKET_ERROR_MESSAGES.vj_excluded_clips_invalid).toBe(
      'excludedClipIds must be an array of at most 200 clip ids.',
    );
  });
});
