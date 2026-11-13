import { HttpException, HttpStatus } from '@nestjs/common';
import {
  VJ_LIMITS,
  type VjAckFailure,
  type VjSocketErrorCode,
  type VjStageState,
} from './vj.contract';

/** Every reason code a VJ REST or upload refusal can carry: the v1 contract
 *  section 4 table, then the v2 contract section 5 table, each in table order,
 *  with the sequences contract 4.3 codes after `VJ_SETLIST_FULL`. */
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
  'VJ_CLIP_FAVORITE_INVALID',
  'VJ_CLIP_SPEED_INVALID',
  'VJ_CLIP_LOOP_MODE_INVALID',
  'VJ_CLIP_LOOP_INVALID',
  'VJ_EVENT_NOT_FOUND',
  'VJ_EVENT_NOT_LINKABLE',
  'VJ_SCENE_NOT_FOUND',
  'VJ_SCENE_NAME_REQUIRED',
  'VJ_SCENE_NAME_TOO_LONG',
  'VJ_SCENE_LIMIT_REACHED',
  'VJ_SCENE_LOOK_INVALID',
  'VJ_SCENE_CLIP_NOT_FOUND',
  'VJ_SCENE_REORDER_MISMATCH',
  'VJ_SETLIST_NOT_FOUND',
  'VJ_SETLIST_NAME_REQUIRED',
  'VJ_SETLIST_NAME_TOO_LONG',
  'VJ_SETLIST_NAME_TAKEN',
  'VJ_SETLIST_LIMIT_REACHED',
  'VJ_SETLIST_REORDER_MISMATCH',
  'VJ_SETLIST_ITEMS_INVALID',
  'VJ_SETLIST_FULL',
  'VJ_SETLIST_STEP_INVALID',
  'VJ_SETLIST_STEP_DURATION_INVALID',
  'VJ_SETLIST_ITEM_NOT_FOUND',
  'VJ_SETLIST_LOOP_INVALID',
  'VJ_SETLIST_PATCH_EMPTY',
  'VJ_CONNECTION_NOT_FOUND',
  'VJ_CONNECTION_NOT_YOURS',
] as const;
export type VjRefusalCode = (typeof VJ_REFUSAL_CODES)[number];

/** Status and fixed message of every refusal the VJ routes answer with.
 *  No message interpolates a clip title, pack name, scene name, set list
 *  name, event title, look, file name or key. */
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
    message:
      'This account has no VJ access: VJ uploads need the Admin role or the VJ operator grant.',
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
  VJ_CLIP_FAVORITE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'isFavorite must be true or false.',
  },
  VJ_CLIP_SPEED_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The default speed must be 0.25, 0.5, 1, 1.5, 2 or 4.',
  },
  VJ_CLIP_LOOP_MODE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The loop mode must be loop or pingPong.',
  },
  VJ_CLIP_LOOP_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: `Loop points must sit inside the clip and leave at least ${VJ_LIMITS.loopMinLengthMs} ms between them.`,
  },
  VJ_EVENT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No event has this id.',
  },
  VJ_EVENT_NOT_LINKABLE: {
    status: HttpStatus.CONFLICT,
    message:
      'Only a published event open to the public or to members can link to a pack.',
  },
  VJ_SCENE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No VJ scene has this id.',
  },
  VJ_SCENE_NAME_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A scene needs a name.',
  },
  VJ_SCENE_NAME_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A scene name can be at most ${VJ_LIMITS.sceneNameMax} characters.`,
  },
  VJ_SCENE_LIMIT_REACHED: {
    status: HttpStatus.CONFLICT,
    message: `The library holds at most ${VJ_LIMITS.scenesMax} scenes.`,
  },
  VJ_SCENE_LOOK_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The scene look holds a field the projector cannot use.',
  },
  VJ_SCENE_CLIP_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'The scene look names a clip that no longer exists.',
  },
  VJ_SCENE_REORDER_MISMATCH: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The new order must list every scene exactly once.',
  },
  VJ_SETLIST_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No VJ set list has this id.',
  },
  VJ_SETLIST_NAME_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A set list needs a name.',
  },
  VJ_SETLIST_NAME_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A set list name can be at most ${VJ_LIMITS.setlistNameMax} characters.`,
  },
  VJ_SETLIST_NAME_TAKEN: {
    status: HttpStatus.CONFLICT,
    message: 'Another set list already has this name.',
  },
  VJ_SETLIST_LIMIT_REACHED: {
    status: HttpStatus.CONFLICT,
    message: `The library holds at most ${VJ_LIMITS.setlistsMax} set lists.`,
  },
  VJ_SETLIST_REORDER_MISMATCH: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The new order must list every set list exactly once.',
  },
  VJ_SETLIST_ITEMS_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'items must be an array of steps.',
  },
  VJ_SETLIST_FULL: {
    status: HttpStatus.CONFLICT,
    message: `A set list holds at most ${VJ_LIMITS.setlistItemsMax} steps.`,
  },
  VJ_SETLIST_STEP_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Each step needs a kind of scene or clip, the matching uuid, and only the fields id, kind, sceneId, clipId and duration.',
  },
  VJ_SETLIST_STEP_DURATION_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'A step length must be 2 to 600 seconds, or 4, 8, 16, 32 or 64 beats.',
  },
  VJ_SETLIST_ITEM_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'A step id names no item of this set list.',
  },
  VJ_SETLIST_LOOP_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'isLooping must be true or false.',
  },
  VJ_SETLIST_PATCH_EMPTY: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The update names no field to change.',
  },
  VJ_CONNECTION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No live VJ screen or remote has this connection id.',
  },
  VJ_CONNECTION_NOT_YOURS: {
    status: HttpStatus.FORBIDDEN,
    message: "This VJ connection belongs to another operator's show.",
  },
};

/** A body field a refusal may carry beside `statusCode`, `message` and `code`. */
export type VjRefusalExtra =
  | 'packId'
  | 'field'
  | 'kind'
  | 'maxBytes'
  | 'setlistId'
  | 'sceneId'
  | 'clipId'
  | 'lookField';

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
  VJ_CLIP_NOT_FOUND: ['clipId'],
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
  VJ_CLIP_FAVORITE_INVALID: [],
  VJ_CLIP_SPEED_INVALID: [],
  VJ_CLIP_LOOP_MODE_INVALID: [],
  VJ_CLIP_LOOP_INVALID: [],
  VJ_EVENT_NOT_FOUND: [],
  VJ_EVENT_NOT_LINKABLE: [],
  VJ_SCENE_NOT_FOUND: ['sceneId'],
  VJ_SCENE_NAME_REQUIRED: [],
  VJ_SCENE_NAME_TOO_LONG: [],
  VJ_SCENE_LIMIT_REACHED: [],
  VJ_SCENE_LOOK_INVALID: ['lookField'],
  VJ_SCENE_CLIP_NOT_FOUND: ['lookField'],
  VJ_SCENE_REORDER_MISMATCH: [],
  VJ_SETLIST_NOT_FOUND: [],
  VJ_SETLIST_NAME_REQUIRED: [],
  VJ_SETLIST_NAME_TOO_LONG: [],
  VJ_SETLIST_NAME_TAKEN: ['setlistId'],
  VJ_SETLIST_LIMIT_REACHED: [],
  VJ_SETLIST_REORDER_MISMATCH: [],
  VJ_SETLIST_ITEMS_INVALID: [],
  VJ_SETLIST_FULL: ['setlistId'],
  VJ_SETLIST_STEP_INVALID: [],
  VJ_SETLIST_STEP_DURATION_INVALID: [],
  VJ_SETLIST_ITEM_NOT_FOUND: [],
  VJ_SETLIST_LOOP_INVALID: [],
  VJ_SETLIST_PATCH_EMPTY: [],
  VJ_CONNECTION_NOT_FOUND: [],
  VJ_CONNECTION_NOT_YOURS: [],
};

/** What a caller may hand `vjError`: the body extras, each copied only when
 *  the code lists it. `sceneId` and `clipId` go only on a set list item
 *  refusal (a scene or clip route's own `:id` is never echoed), and
 *  `lookField` is a dot path of schema names with no value in it. */
export interface VjErrorOptions {
  field?: 'storageKey' | 'thumbnailStorageKey' | 'previewStorageKey';
  packId?: string;
  kind?: 'vj_clip' | 'vj_thumbnail' | 'vj_preview';
  maxBytes?: number;
  setlistId?: string;
  sceneId?: string;
  clipId?: string;
  lookField?: string;
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

/** The `exception` frame message for a caller with no VJ access: neither an
 *  active Admin nor an active holder of the `vj_operator` staff grant
 *  (`domainCode: 'vj_not_admin'`, a wire code that keeps its name). */
export const VJ_NOT_ADMIN_MESSAGE =
  'This account has no VJ access: VJ needs the Admin role or the VJ operator grant.';

/** The `exception` frame message sent to a screen socket another socket with
 *  the same `screenId` replaced (`domainCode: 'vj_screen_replaced'`). */
export const VJ_SCREEN_REPLACED_MESSAGE = 'Another tab opened this screen.';

/** The `exception` frame message sent to a screen or remote socket stopped
 *  from the live connections panel of the VJ library
 *  (`domainCode: 'vj_stopped'`). */
export const VJ_STOPPED_MESSAGE = 'Stopped from the VJ library';

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
  vj_transition_mode_invalid: 'The transition mode is outside the catalog.',
  vj_fade_out_of_range: `A transition length in milliseconds must be a whole number from ${VJ_LIMITS.fadeMsMin} to ${VJ_LIMITS.fadeMsMax}.`,
  vj_overlay_text_invalid:
    'The overlay text must be one line of text without control characters.',
  vj_overlay_text_too_long: `The overlay text can be at most ${VJ_LIMITS.overlayTextMax} characters.`,
  vj_overlay_text_blank: 'The overlay needs text before it can show.',
  vj_overlay_style_invalid: 'The overlay style is outside the list.',
  vj_speed_invalid: 'The speed must be 0.25, 0.5, 1, 1.5, 2 or 4.',
  vj_effect_flag_invalid: 'Each on and off switch must be true or false.',
  vj_shuffle_interval_invalid: `The shuffle interval must be ${VJ_LIMITS.shuffleSecondsMin} to ${VJ_LIMITS.shuffleSecondsMax} seconds, or 4, 8, 16 or 32 beats.`,
  vj_bpm_out_of_range: `The tempo must be from ${VJ_LIMITS.bpmMin} to ${VJ_LIMITS.bpmMax} BPM.`,
  vj_client_outdated:
    'This page speaks an older VJ contract. Reload it to attach.',
  vj_immediate_not_allowed:
    'Only blackout, reset look and stopping the strobe may skip the beat.',
  vj_transition_length_invalid:
    'The transition length needs a known unit, and a beat length of 1, 2, 4, 8 or 16 beats.',
  vj_overlay_position_invalid:
    'The overlay position must be top, center or bottom.',
  vj_overlay_size_invalid: 'The overlay size must be s, m, l or xl.',
  vj_color_token_invalid: 'The colour must come from the VJ palette.',
  vj_overlay_hide_out_of_range: `Overlay auto-hide must be from ${VJ_LIMITS.overlayHideAfterMsMin} to ${VJ_LIMITS.overlayHideAfterMsMax} milliseconds.`,
  vj_effect_unknown:
    'The effect settings are malformed or name an effect outside the catalog.',
  vj_effect_amount_invalid: 'Each effect amount must be a number from 0 to 1.',
  vj_effect_variant_invalid:
    'The effect variant is outside the options of that effect.',
  vj_effect_exclusive_conflict:
    'Freeze, reverse and ping-pong play one at a time.',
  vj_effects_too_many: `At most ${VJ_LIMITS.effectsOnMax} effects can be on at once.`,
  vj_generator_invalid: 'The generator is outside the catalog.',
  vj_generator_variant_invalid:
    'The generator variant is outside the options of that generator.',
  vj_downbeat_out_of_range: `The downbeat must lie within ${VJ_LIMITS.downbeatSkewMsMax} ms of the server clock.`,
  vj_quantize_invalid: 'Quantize must be off, beat or bar.',
  vj_tempo_source_invalid: 'The tempo source must be manual, tap or mic.',
  vj_tempo_source_conflict:
    'Mic tempo takes its BPM and downbeat from the lead screen alone.',
  vj_mic_unavailable: 'The lead screen has its mic off.',
  vj_mix_amount_invalid: 'The mix amount must be a number from 0 to 1.',
  vj_blend_mode_invalid: 'The blend mode is outside the list.',
  vj_mix_empty: 'The mix layer holds no clip to swap in.',
  vj_shuffle_source_invalid: 'The shuffle source must be pack or favorites.',
  vj_excluded_clips_invalid: `excludedClipIds must be an array of at most ${VJ_LIMITS.excludedClipIdsMax} clip ids.`,
  vj_clip_excluded: 'The advance names a clip the stage skips.',
  vj_clip_not_favorite:
    'The favorites shuffle advance names a clip outside the favorites.',
  vj_screen_not_attached: 'No screen with this id is connected.',
  vj_override_invalid:
    'A screen override sets exactly one clip or one generator.',
  vj_overrides_too_many: `At most ${VJ_LIMITS.screenOverridesMax} screens can carry an override.`,
  vj_scene_not_found: 'No VJ scene has this id.',
  vj_setlist_not_found: 'No VJ set list has this id.',
  vj_setlist_none: 'No set list is active on this stage.',
  vj_setlist_empty: 'The set list holds no steps.',
  vj_setlist_index_invalid:
    'The set list index is outside the list or names no set list.',
  vj_setlist_start: 'The set list is already at its first step.',
  vj_setlist_end: 'The set list holds no step after this one.',
  vj_stale_setlist: 'The set list position moved while this command was read.',
  vj_countdown_target_conflict:
    'A countdown takes either targetAt or durationMs.',
  vj_countdown_out_of_range: `The countdown must end ${VJ_LIMITS.countdownLeadMsMin} to ${VJ_LIMITS.countdownLeadMsMax} ms from now.`,
  vj_countdown_target_missing: 'A visible countdown needs a future end time.',
  vj_countdown_label_invalid:
    'The countdown label must be one line of text without control characters.',
  vj_countdown_label_too_long: `The countdown label can be at most ${VJ_LIMITS.countdownLabelMax} characters.`,
  vj_logo_corner_invalid:
    'The logo corner must be topLeft, topRight, bottomLeft or bottomRight.',
  vj_event_card_kind_invalid: 'The event card kind must be qr or nextEvent.',
  vj_event_card_no_event: 'The active pack links no event.',
  vj_server_error: 'A server read failed while handling this frame.',
  vj_stopped: VJ_STOPPED_MESSAGE,
  vj_render_mode_invalid: 'The render mode must be effects or simple.',
  vj_no_screens_connected: 'No screen is connected to this stage.',
  vj_setlist_flash_unconfirmed:
    'The next step flashes and no one confirmed the flash warning for this run.',
};

/** The one way a VJ socket frame is refused: `{ ok: false, code, message,
 *  serverNow }`, plus the current `state` when one is given (the stale, lead
 *  and silent refusals), so the sender can snap to it. The gateway overwrites
 *  `serverNow` right before the ack leaves (contract 7.2). */
export function vjAckFailure(
  code: VjSocketErrorCode,
  state?: VjStageState,
): VjAckFailure {
  const failure: VjAckFailure = {
    ok: false,
    code,
    message: VJ_SOCKET_ERROR_MESSAGES[code],
    serverNow: Date.now(),
  };
  if (state !== undefined) {
    failure.state = state;
  }
  return failure;
}
