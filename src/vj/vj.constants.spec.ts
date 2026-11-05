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

  it('lists the 26 server codes in contract order', () => {
    expect(VJ_REFUSAL_CODES).toHaveLength(26);
    expect(VJ_REFUSAL_CODES[0]).toBe('VJ_PACK_NOT_FOUND');
    expect(VJ_REFUSAL_CODES[25]).toBe('VJ_UPLOAD_MISSING');
    expect(Object.keys(VJ_REFUSALS)).toEqual([...VJ_REFUSAL_CODES]);
  });

  it('copies only the extras listed for the code', () => {
    const options: VjErrorOptions = {
      field: 'storageKey',
      packId: PACK_ID,
      kind: 'vj_clip',
      maxBytes: 104857600,
    };
    expect(vjError('VJ_PACK_FULL', options).getResponse()).toEqual({
      statusCode: 409,
      message: VJ_REFUSALS.VJ_PACK_FULL.message,
      code: 'VJ_PACK_FULL',
      packId: PACK_ID,
    });
    expect(vjError('VJ_UPLOAD_TOO_LARGE', options).getResponse()).toEqual({
      statusCode: 413,
      message: VJ_REFUSALS.VJ_UPLOAD_TOO_LARGE.message,
      code: 'VJ_UPLOAD_TOO_LARGE',
      kind: 'vj_clip',
      maxBytes: 104857600,
      field: 'storageKey',
    });
    expect(
      vjError('VJ_UPLOAD_TYPE_UNSUPPORTED', options).getResponse(),
    ).toEqual({
      statusCode: 400,
      message: VJ_REFUSALS.VJ_UPLOAD_TYPE_UNSUPPORTED.message,
      code: 'VJ_UPLOAD_TYPE_UNSUPPORTED',
      kind: 'vj_clip',
    });
    expect(vjError('VJ_CLIP_KEY_IN_USE', options).getResponse()).toEqual({
      statusCode: 409,
      message: VJ_REFUSALS.VJ_CLIP_KEY_IN_USE.message,
      code: 'VJ_CLIP_KEY_IN_USE',
      field: 'storageKey',
    });
    expect(vjError('VJ_PACK_NOT_FOUND', options).getResponse()).toEqual({
      statusCode: 404,
      message: VJ_REFUSALS.VJ_PACK_NOT_FOUND.message,
      code: 'VJ_PACK_NOT_FOUND',
    });
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
  });

  it('keeps every message a fixed sentence', () => {
    const strayOptions = {
      packId: PACK_ID,
      title: 'Secret title',
      storageKey: 'vj-clips/abc/def.mp4',
    } as unknown as VjErrorOptions;
    for (const code of VJ_REFUSAL_CODES) {
      const body = vjError(code, strayOptions).getResponse() as Record<
        string,
        unknown
      >;
      const message = body.message as string;
      expect(message).not.toContain(PACK_ID);
      expect(message).not.toContain('Secret title');
      expect(message).not.toContain('vj-clips/');
      expect(body).not.toHaveProperty('title');
      expect(body).not.toHaveProperty('storageKey');
      expect(message).not.toMatch(/[\u2013\u2014]/);
    }
    expect(
      new Set(Object.values(VJ_REFUSALS).map(({ message }) => message)).size,
    ).toBe(26);
  });
});

describe('vjAckFailure', () => {
  it('builds socket failures with and without the state', () => {
    const withoutState = vjAckFailure('vj_patch_empty');
    expect(withoutState).toEqual({
      ok: false,
      code: 'vj_patch_empty',
      message: VJ_SOCKET_ERROR_MESSAGES.vj_patch_empty,
    });
    expect(withoutState).not.toHaveProperty('state');

    const state = createVjStageState('epoch-1', 1000);
    expect(vjAckFailure('vj_stale_command', state)).toEqual({
      ok: false,
      code: 'vj_stale_command',
      message: VJ_SOCKET_ERROR_MESSAGES.vj_stale_command,
      state,
    });

    expect(Object.keys(VJ_SOCKET_ERROR_MESSAGES)).toHaveLength(27);
    expect(Object.keys(VJ_SOCKET_ERROR_MESSAGES).sort()).toEqual(
      [...VJ_SOCKET_ERROR_CODES].sort(),
    );
    expect(new Set(Object.values(VJ_SOCKET_ERROR_MESSAGES)).size).toBe(27);
    for (const message of Object.values(VJ_SOCKET_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
