import { HttpException, HttpStatus } from '@nestjs/common';
import {
  VJ_LIMITS,
  type VjAckFailure,
  type VjSocketErrorCode,
  type VjStageState,
} from './vj.contract';

/** Every reason code a VJ REST or upload refusal can carry, in contract
 *  section 4 table order. */
export const VJ_REFUSAL_CODES = [
  'VJ_PACK_NOT_FOUND',
  'VJ_PACK_NAME_REQUIRED',
  'VJ_PACK_NAME_TOO_LONG',
  'VJ_PACK_NAME_TAKEN',
  'VJ_PACK_LIMIT_REACHED',
  'VJ_PACK_REORDER_MISMATCH',
  'VJ_PACK_FULL',
  'VJ_PACK_CLIPS_REORDER_MISMATCH',
  'VJ_CLIP_NOT_FOUND',
  'VJ_CLIP_ALREADY_IN_PACK',
  'VJ_CLIP_NOT_IN_PACK',
  'VJ_CLIP_TITLE_REQUIRED',
  'VJ_CLIP_TITLE_TOO_LONG',
  'VJ_CLIP_FIT_MODE_INVALID',
  'VJ_CLIP_DIMENSIONS_INVALID',
  'VJ_CLIP_DURATION_INVALID',
  'VJ_CLIP_KEY_INVALID',
  'VJ_CLIP_KEY_IN_USE',
  'VJ_CLIP_IDS_INVALID',
  'VJ_LIBRARY_FULL',
  'VJ_UPLOAD_NOT_ADMIN',
  'VJ_UPLOAD_TYPE_UNSUPPORTED',
  'VJ_UPLOAD_TOO_LARGE',
  'VJ_UPLOAD_FORMAT_MOV',
  'VJ_UPLOAD_CONTENT_MISMATCH',
  'VJ_UPLOAD_MISSING',
] as const;
export type VjRefusalCode = (typeof VJ_REFUSAL_CODES)[number];

/** Status and fixed message of every refusal the VJ routes answer with.
 *  No message interpolates a clip title, pack name, file name or key. */
export const VJ_REFUSALS: Record<
  VjRefusalCode,
  { status: HttpStatus; message: string }
> = {
  VJ_PACK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No VJ pack has this id.',
  },
  VJ_PACK_NAME_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A pack needs a name.',
  },
  VJ_PACK_NAME_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A pack name can be at most ${VJ_LIMITS.packNameMax} characters.`,
  },
  VJ_PACK_NAME_TAKEN: {
    status: HttpStatus.CONFLICT,
    message: 'Another pack already has this name.',
  },
  VJ_PACK_LIMIT_REACHED: {
    status: HttpStatus.CONFLICT,
    message: `The library holds at most ${VJ_LIMITS.packsMax} packs.`,
  },
  VJ_PACK_REORDER_MISMATCH: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The new order must list every pack exactly once.',
  },
  VJ_PACK_FULL: {
    status: HttpStatus.CONFLICT,
    message: `A pack holds at most ${VJ_LIMITS.packClipsMax} clips.`,
  },
  VJ_PACK_CLIPS_REORDER_MISMATCH: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The new order must list every clip of the pack exactly once.',
  },
  VJ_CLIP_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No VJ clip has this id.',
  },
  VJ_CLIP_ALREADY_IN_PACK: {
    status: HttpStatus.CONFLICT,
    message: 'This clip is already in the pack.',
  },
  VJ_CLIP_NOT_IN_PACK: {
    status: HttpStatus.NOT_FOUND,
    message: 'This clip is not in the pack.',
  },
  VJ_CLIP_TITLE_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A clip needs a title.',
  },
  VJ_CLIP_TITLE_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A clip title can be at most ${VJ_LIMITS.clipTitleMax} characters.`,
  },
  VJ_CLIP_FIT_MODE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The fit mode must be fill or fit.',
  },
  VJ_CLIP_DIMENSIONS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Width and height must be whole numbers from 1 to 16384.',
  },
  VJ_CLIP_DURATION_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'A video needs a duration from 1 ms to one hour, and a GIF takes none.',
  },
  VJ_CLIP_KEY_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The storage key is not a VJ upload key.',
  },
  VJ_CLIP_KEY_IN_USE: {
    status: HttpStatus.CONFLICT,
    message: 'Another clip already stores this upload.',
  },
  VJ_CLIP_IDS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: `clipIds must list 1 to ${VJ_LIMITS.mediaClipIdsMax} clip ids separated by commas.`,
  },
  VJ_LIBRARY_FULL: {
    status: HttpStatus.CONFLICT,
    message: `The library holds at most ${VJ_LIMITS.libraryClipsMax} clips.`,
  },
  VJ_UPLOAD_NOT_ADMIN: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only an admin may upload VJ clips.',
  },
  VJ_UPLOAD_TYPE_UNSUPPORTED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This file type is not accepted for this VJ upload.',
  },
  VJ_UPLOAD_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'The file is over the size cap for this VJ upload.',
  },
  VJ_UPLOAD_FORMAT_MOV: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The upload is a QuickTime MOV file. Export it as MP4 or WebM.',
  },
  VJ_UPLOAD_CONTENT_MISMATCH: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The uploaded bytes do not match the file type.',
  },
  VJ_UPLOAD_MISSING: {
    status: HttpStatus.CONFLICT,
    message: 'The upload never reached storage.',
  },
};

/** A body field a refusal may carry beside `statusCode`, `message` and `code`. */
export type VjRefusalExtra = 'packId' | 'field' | 'kind' | 'maxBytes';

/** The extra body fields each code carries. `vjError` copies only these from
 *  its options, so a stray option never reaches a body. */
export const VJ_REFUSAL_EXTRAS: Record<
  VjRefusalCode,
  readonly VjRefusalExtra[]
> = {
  VJ_PACK_NOT_FOUND: [],
  VJ_PACK_NAME_REQUIRED: [],
  VJ_PACK_NAME_TOO_LONG: [],
  VJ_PACK_NAME_TAKEN: ['packId'],
  VJ_PACK_LIMIT_REACHED: [],
  VJ_PACK_REORDER_MISMATCH: [],
  VJ_PACK_FULL: ['packId'],
  VJ_PACK_CLIPS_REORDER_MISMATCH: [],
  VJ_CLIP_NOT_FOUND: [],
  VJ_CLIP_ALREADY_IN_PACK: ['packId'],
  VJ_CLIP_NOT_IN_PACK: ['packId'],
  VJ_CLIP_TITLE_REQUIRED: [],
  VJ_CLIP_TITLE_TOO_LONG: [],
  VJ_CLIP_FIT_MODE_INVALID: [],
  VJ_CLIP_DIMENSIONS_INVALID: [],
  VJ_CLIP_DURATION_INVALID: [],
  VJ_CLIP_KEY_INVALID: ['field'],
  VJ_CLIP_KEY_IN_USE: ['field'],
  VJ_CLIP_IDS_INVALID: [],
  VJ_LIBRARY_FULL: [],
  VJ_UPLOAD_NOT_ADMIN: [],
  VJ_UPLOAD_TYPE_UNSUPPORTED: ['kind'],
  VJ_UPLOAD_TOO_LARGE: ['kind', 'maxBytes', 'field'],
  VJ_UPLOAD_FORMAT_MOV: ['field'],
  VJ_UPLOAD_CONTENT_MISMATCH: ['field'],
  VJ_UPLOAD_MISSING: ['field'],
};

/** What a caller may hand `vjError`: the body extras, each copied only when
 *  the code lists it. */
export interface VjErrorOptions {
  field?: 'storageKey' | 'thumbnailStorageKey';
  packId?: string;
  kind?: 'vj_clip' | 'vj_thumbnail';
  maxBytes?: number;
}

/** The one way the VJ routes refuse a request: `{ statusCode, message, code }`
 *  plus each extra listed for the code in `VJ_REFUSAL_EXTRAS` whose option is
 *  defined. The message is always the fixed sentence from `VJ_REFUSALS`. */
export function vjError(
  code: VjRefusalCode,
  options?: VjErrorOptions,
): HttpException {
  const refusal = VJ_REFUSALS[code];
  const body: Record<string, unknown> = {
    statusCode: refusal.status,
    message: refusal.message,
    code,
  };
  for (const extra of VJ_REFUSAL_EXTRAS[code]) {
    const value = options?.[extra];
    if (value !== undefined) {
      body[extra] = value;
    }
  }
  return new HttpException(body, refusal.status);
}

/** The `exception` frame message for a caller who is no longer an active
 *  Admin (`domainCode: 'vj_not_admin'`). */
export const VJ_NOT_ADMIN_MESSAGE = 'VJ is open to admins only.';

/** The `exception` frame message sent to a screen socket another socket with
 *  the same `screenId` replaced (`domainCode: 'vj_screen_replaced'`). */
export const VJ_SCREEN_REPLACED_MESSAGE = 'Another tab opened this screen.';

/** The fixed English sentence of every socket refusal, for logs and the
 *  ack's `message`. No sentence interpolates a payload value. */
export const VJ_SOCKET_ERROR_MESSAGES: Record<VjSocketErrorCode, string> = {
  vj_not_admin: VJ_NOT_ADMIN_MESSAGE,
  vj_not_attached: 'Attach this socket as a screen or a remote first.',
  vj_already_attached:
    'This socket is already attached. Reconnect to switch roles.',
  vj_wrong_role: 'This frame belongs to the other attach role.',
  vj_screen_id_invalid: 'A screen attach needs a uuid screenId.',
  vj_client_id_invalid:
    'A remote command needs a uuid clientId and a positive whole commandSequence.',
  vj_rate_limited: 'Too many frames in a short time. Try again in a moment.',
  vj_stale_command: 'A newer command from this remote was already applied.',
  vj_stale_clip_sequence:
    'The live clip changed since this screen armed its shuffle.',
  vj_not_lead: 'Only the lead screen advances the shuffle.',
  vj_shuffle_off: 'Shuffle is off on this stage.',
  vj_no_active_pack: 'No pack is active on this stage.',
  vj_pack_not_found: 'No VJ pack has this id.',
  vj_clip_not_found: 'No VJ clip has this id.',
  vj_clip_not_in_pack: 'This clip is outside the active pack.',
  vj_patch_empty: 'The command names no field to change.',
  vj_transition_mode_invalid: 'The transition mode must be fade or cut.',
  vj_fade_out_of_range: `The fade must be a whole number of milliseconds from ${VJ_LIMITS.fadeMsMin} to ${VJ_LIMITS.fadeMsMax}.`,
  vj_overlay_text_invalid:
    'The overlay text must be one line of text without control characters.',
  vj_overlay_text_too_long: `The overlay text can be at most ${VJ_LIMITS.overlayTextMax} characters.`,
  vj_overlay_text_blank: 'The overlay needs text before it can show.',
  vj_overlay_style_invalid: 'The overlay style must be big or ticker.',
  vj_speed_invalid: 'The speed must be 0.5, 1, 1.5 or 2.',
  vj_effect_flag_invalid: 'Each on and off switch must be true or false.',
  vj_shuffle_interval_invalid: `The shuffle interval must be ${VJ_LIMITS.shuffleSecondsMin} to ${VJ_LIMITS.shuffleSecondsMax} seconds, or 4, 8, 16 or 32 beats.`,
  vj_bpm_out_of_range: `The tempo must be from ${VJ_LIMITS.bpmMin} to ${VJ_LIMITS.bpmMax} BPM.`,
  vj_server_error: 'A server read failed while handling this frame.',
};

/** The one way a VJ socket frame is refused: `{ ok: false, code, message }`,
 *  plus the current `state` when one is given (the stale and lead refusals),
 *  so the sender can snap to it. */
export function vjAckFailure(
  code: VjSocketErrorCode,
  state?: VjStageState,
): VjAckFailure {
  const failure: VjAckFailure = {
    ok: false,
    code,
    message: VJ_SOCKET_ERROR_MESSAGES[code],
  };
  if (state !== undefined) {
    failure.state = state;
  }
  return failure;
}
