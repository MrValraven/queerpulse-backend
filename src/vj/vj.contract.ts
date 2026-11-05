/**
 * VJ wire contract: the backend source of truth for the shared constants,
 * the live stage state, the screen status and every `/vj` socket frame.
 * `queerpulse/src/shared/contracts/vj.ts` mirrors this file name for name and
 * value for value. Contract `QUEERPULSE-VJ-CONTRACT-2026-11-05.md`, sections
 * 2 and 6. This module imports nothing at runtime.
 */

/** What a clip plays as: a video file or an animated GIF. */
export const VJ_MEDIA_KINDS = ['video', 'gif'] as const;
export type VjMediaKind = (typeof VJ_MEDIA_KINDS)[number];

/** The content types a stored clip may have. */
export const VJ_CLIP_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'image/gif',
] as const;
export type VjClipMimeType = (typeof VJ_CLIP_MIME_TYPES)[number];

/** How a clip fills the screen: cropped to fill it, or letterboxed to fit. */
export const VJ_FIT_MODES = ['fill', 'fit'] as const;
export type VjFitMode = (typeof VJ_FIT_MODES)[number];
/** The fit mode a clip created with none starts with. */
export const DEFAULT_VJ_FIT_MODE: VjFitMode = 'fill';

/** How the screens move from one clip to the next. */
export const VJ_TRANSITION_MODES = ['fade', 'cut'] as const;
export type VjTransitionMode = (typeof VJ_TRANSITION_MODES)[number];

/** How overlay text is drawn: one big line or a scrolling ticker. */
export const VJ_OVERLAY_STYLES = ['big', 'ticker'] as const;
export type VjOverlayStyle = (typeof VJ_OVERLAY_STYLES)[number];

/** Playback rates a remote may pick; GIFs ignore them. */
export const VJ_SPEEDS = [0.5, 1, 1.5, 2] as const;
export type VjSpeed = (typeof VJ_SPEEDS)[number];

/** Whether the shuffle interval counts seconds or beats of the tempo. */
export const VJ_SHUFFLE_INTERVAL_KINDS = ['seconds', 'beats'] as const;
export type VjShuffleIntervalKind = (typeof VJ_SHUFFLE_INTERVAL_KINDS)[number];

/** The beat counts a beats interval may take. */
export const VJ_SHUFFLE_BEAT_COUNTS = [4, 8, 16, 32] as const;
export type VjShuffleBeatCount = (typeof VJ_SHUFFLE_BEAT_COUNTS)[number];

/** The two roles a socket can attach as. */
export const VJ_ATTACH_ROLES = ['screen', 'remote'] as const;
export type VjAttachRole = (typeof VJ_ATTACH_ROLES)[number];

/** Every size, length, count and timing bound of the VJ contract. */
export const VJ_LIMITS = {
  /** 100 MB, the `vj_clip` kind cap. */
  clipMaxBytes: 104_857_600,
  /** 256 KB, the `vj_thumbnail` kind cap. */
  thumbnailMaxBytes: 262_144,
  /** Thumbnail longest edge in pixels. */
  thumbnailLongEdgePx: 480,
  clipTitleMax: 120,
  packNameMax: 60,
  packsMax: 50,
  packClipsMax: 200,
  libraryClipsMax: 1000,
  dimensionMax: 16_384,
  durationMsMax: 3_600_000,
  fadeMsMin: 0,
  fadeMsMax: 4000,
  fadeMsDefault: 800,
  overlayTextMax: 80,
  shuffleSecondsMin: 2,
  shuffleSecondsMax: 60,
  shuffleSecondsDefault: 8,
  shuffleBeatsDefault: 8,
  bpmMin: 60,
  bpmMax: 200,
  bpmDefault: 124,
  strobeMaxFlashesPerSecond: 3,
  strobeMaxDurationMs: 10_000,
  /** Lifetime of a preload URL from GET /admin/vj/packs/:id/media. */
  mediaUrlTtlSeconds: 900,
  /** Most ids in one `clipIds` query. */
  mediaClipIdsMax: 200,
} as const;

/** How the screens move between clips. */
export interface VjTransition {
  /** Default 'fade'. */
  mode: VjTransitionMode;
  /** Integer 0..4000, default 800. */
  fadeMs: number;
}

/** Text drawn over the clips. */
export interface VjOverlay {
  /** Trimmed, 0..80 code points, default ''. */
  text: string;
  /** Default 'big'. */
  style: VjOverlayStyle;
  /** Default false; true needs non-blank text. */
  isVisible: boolean;
}

/** Effects the screens apply to whatever plays. */
export interface VjEffects {
  /** Default 1; GIFs ignore it. */
  speed: VjSpeed;
  /** Default false. */
  isMonochrome: boolean;
  /** Default false. */
  isMirrored: boolean;
  /** Default false. */
  isHueCycling: boolean;
  /** Default false; the server turns it off 10 s after it went on. */
  isStrobing: boolean;
  /** Default false. */
  isBlackout: boolean;
  /** Server epoch ms when isStrobing last went true; null while off. Shown on
   *  the remote as a countdown. Screens time the 10 s cut-off on their own
   *  clock from the moment they applied isStrobing: true (section 6.9). */
  strobeStartedAt: number | null;
}

/** The lead screen's automatic clip changes. */
export interface VjShuffle {
  /** Default false. */
  isOn: boolean;
  /** Default 'seconds'. */
  intervalKind: VjShuffleIntervalKind;
  /** 'seconds': integer 2..60. 'beats': one of 4, 8, 16, 32. Default 8 (either kind). */
  intervalValue: number;
  /** 60..200, rounded to one decimal place; default 124. */
  bpm: number;
}

/** The whole live stage of one admin, broadcast in full on every change. */
export interface VjStageState {
  /** Random uuid minted when the server creates this stage in memory. A new
   *  value means the backend restarted or the stage was evicted. */
  stageEpoch: string;
  /** Starts at 0 for a fresh stage; +1 on every applied change. */
  revision: number;
  /** Starts at 0; +1 whenever liveClipId or activePackId is set, including a
   *  re-tap of the live clip. Shuffle reports must name the current value. */
  clipSequence: number;
  /** Default null. */
  activePackId: string | null;
  /** Default null (black screen). */
  liveClipId: string | null;
  transition: VjTransition;
  overlay: VjOverlay;
  effects: VjEffects;
  shuffle: VjShuffle;
  /** Server epoch ms of the last applied change (or creation). */
  updatedAt: number;
}

/** What a screen sends on attach to seed a stage the server lost. */
export type VjStageRestore = Pick<
  VjStageState,
  | 'stageEpoch'
  | 'revision'
  | 'activePackId'
  | 'liveClipId'
  | 'transition'
  | 'overlay'
  | 'effects'
  | 'shuffle'
>;

/** Why a `stage:state` frame was sent. */
export const VJ_STAGE_CAUSES = [
  'attach',
  'restore',
  'command',
  'shuffle',
  'strobe_timeout',
  'library',
] as const;
export type VjStageCause = (typeof VJ_STAGE_CAUSES)[number];

/** Builds the default state for a new stage (backend `createVjStageState`,
 *  frontend demo store). */
export function createVjStageState(
  stageEpoch: string,
  now: number,
): VjStageState {
  return {
    stageEpoch,
    revision: 0,
    clipSequence: 0,
    activePackId: null,
    liveClipId: null,
    transition: { mode: 'fade', fadeMs: VJ_LIMITS.fadeMsDefault },
    overlay: { text: '', style: 'big', isVisible: false },
    effects: {
      speed: 1,
      isMonochrome: false,
      isMirrored: false,
      isHueCycling: false,
      isStrobing: false,
      isBlackout: false,
      strobeStartedAt: null,
    },
    shuffle: {
      isOn: false,
      intervalKind: 'seconds',
      intervalValue: VJ_LIMITS.shuffleSecondsDefault,
      bpm: VJ_LIMITS.bpmDefault,
    },
    updatedAt: now,
  };
}

/** The shuffle interval in milliseconds, computed identically on screen,
 *  remote and demo: seconds give `intervalValue * 1000`; beats give
 *  `Math.round(intervalValue * 60000 / bpm)`. */
export function vjShuffleIntervalMs(shuffle: VjShuffle): number {
  if (shuffle.intervalKind === 'seconds') {
    return shuffle.intervalValue * 1000;
  }
  return Math.round((shuffle.intervalValue * 60000) / shuffle.bpm);
}

/** Strobe flashes per second: one flash per beat, capped at 3 per second at
 *  any tempo. */
export function vjStrobeFlashesPerSecond(bpm: number): number {
  return Math.min(VJ_LIMITS.strobeMaxFlashesPerSecond, bpm / 60);
}

/** How far a screen got preloading one clip. */
export const VJ_CLIP_READY_STATES = [
  'queued',
  'loading',
  'ready',
  'failed',
] as const;
export type VjClipReadyState = (typeof VJ_CLIP_READY_STATES)[number];

/** Why a screen could not preload a clip; the remote names it. */
export const VJ_PRELOAD_FAILURES = [
  /** The URL expired twice in a row before its fetch started. */
  'url_expired',
  /** The fetch failed or was cut off. */
  'network',
  /** Cache Storage refused the write (QuotaExceededError). */
  'storage_full',
  /** The browser could not play the cached file. */
  'decode_failed',
  /** The media endpoint no longer lists the clip. */
  'not_found',
] as const;
export type VjPreloadFailure = (typeof VJ_PRELOAD_FAILURES)[number];

/** One clip's preload state on one screen. */
export interface VjScreenClipStatus {
  clipId: string;
  state: VjClipReadyState;
  /** 0..1, bytes received over byteSize; 1 when ready. */
  progress: number;
  /** Set only when state is 'failed'. */
  failure: VjPreloadFailure | null;
}

/** A screen's preload report for one pack. */
export interface VjScreenPreload {
  /** The pack this report covers. */
  packId: string | null;
  /** One entry per clip of that pack, pack order. */
  clips: VjScreenClipStatus[];
}

/** One screen as the remote lists it. */
export interface VjScreenStatus {
  screenId: string;
  /** 1-based, assigned at the first attach of this screenId in this stage
   *  (highest number so far + 1) and kept for the stage's life: "Screen 2". */
  number: number;
  isConnected: boolean;
  /** False while disconnected. */
  isLead: boolean;
  isFullscreen: boolean;
  /** Server epoch ms the current connection attached; null while disconnected. */
  connectedAt: number | null;
  /** Server epoch ms of the last frame or attach from this screen. */
  lastSeenAt: number;
  preload: VjScreenPreload;
}

/** Same codes as ChatWsErrorCode. */
export type VjWsTransportCode =
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_REVOKED'
  | 'PLATFORM_LOCKED'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR';

/** `exception` frame: handshake refusals and FORBIDDEN after a lost admin
 *  role (then disconnect), TOKEN_EXPIRED (then disconnect), and payloads the
 *  ValidationPipe rejects (an undeclared property; the socket stays up and gets no ack). */
export interface VjExceptionFrame {
  status: 'error';
  code: VjWsTransportCode;
  message: unknown;
  /** 'vj_not_admin' on a role refusal. */
  domainCode?: string;
  statusCode?: number;
}

/** Every code a VJ socket ack can refuse with, in contract table order. */
export const VJ_SOCKET_ERROR_CODES = [
  'vj_not_admin',
  'vj_not_attached',
  'vj_already_attached',
  'vj_wrong_role',
  'vj_screen_id_invalid',
  'vj_client_id_invalid',
  'vj_rate_limited',
  'vj_stale_command',
  'vj_stale_clip_sequence',
  'vj_not_lead',
  'vj_shuffle_off',
  'vj_no_active_pack',
  'vj_pack_not_found',
  'vj_clip_not_found',
  'vj_clip_not_in_pack',
  'vj_patch_empty',
  'vj_transition_mode_invalid',
  'vj_fade_out_of_range',
  'vj_overlay_text_invalid',
  'vj_overlay_text_too_long',
  'vj_overlay_text_blank',
  'vj_overlay_style_invalid',
  'vj_speed_invalid',
  'vj_effect_flag_invalid',
  'vj_shuffle_interval_invalid',
  'vj_bpm_out_of_range',
  'vj_server_error',
] as const;
export type VjSocketErrorCode = (typeof VJ_SOCKET_ERROR_CODES)[number];

/** A refused socket frame's acknowledgement. */
export interface VjAckFailure {
  ok: false;
  code: VjSocketErrorCode;
  /** English, for logs; the frontend maps `code` to copy. */
  message: string;
  /** On vj_stale_command, vj_stale_clip_sequence, vj_not_lead, vj_shuffle_off,
   *  vj_no_active_pack: the current state, so the sender can snap to it. */
  state?: VjStageState;
}

/** The acknowledgement of every client frame but `screen:status`. */
export type VjAck<Success extends object = Record<string, never>> =
  ({ ok: true } & Success) | VjAckFailure;

/** Success ack of every stage command. */
export interface VjCommandSuccess {
  /** The state's revision after this command. */
  revision: number;
  /** True when nothing changed (nothing broadcast, revision unchanged). */
  isNoop: boolean;
}

/** The `vj:attach` payload: a screen names itself and may seed a lost stage. */
export type VjAttachPayload =
  | { role: 'screen'; screenId: string; restoreState: VjStageRestore | null }
  | { role: 'remote' };

/** The success ack of `vj:attach`. */
export interface VjAttachSuccess {
  role: VjAttachRole;
  /** Epoch ms, exp * 1000. */
  connectionExpiresAt: number;
  stageEpoch: string;
  /** Screen only: whether this attach seeded the stage from restoreState. */
  isRestored: boolean;
  /** Screen only: whether this screen leads now; null for a remote. */
  isLead: boolean | null;
}

/** The `stage:state` frame. */
export interface VjStageFrame {
  state: VjStageState;
  cause: VjStageCause;
  /** The clientId whose command caused this; null for every other cause. */
  sourceClientId: string | null;
}

/** What changed in the shared library, relayed as `library:changed`. */
export const VJ_LIBRARY_CHANGE_KINDS = [
  'pack_created',
  'pack_renamed',
  'pack_deleted',
  'packs_reordered',
  /** Add, remove, reorder, or a clip created into the pack. */
  'pack_clips_changed',
  'clip_created',
  'clip_updated',
  'clip_deleted',
] as const;
export type VjLibraryChangeKind = (typeof VJ_LIBRARY_CHANGE_KINDS)[number];

/** The `library:changed` frame and the `VJ_LIBRARY_CHANGED` event payload. */
export interface VjLibraryChange {
  kind: VjLibraryChangeKind;
  /** The pack touched, when one is. */
  packId: string | null;
  /** The clip touched, when one is. */
  clipId: string | null;
  /** Every pack whose clip list changed (a clip delete lists all its packs). */
  packIds: string[];
}

/** The pair every remote command carries (contract 6.5): a per-page uuid and
 *  a positive safe integer that grows by one per command. */
export interface VjClientCommandFields {
  clientId: string;
  commandSequence: number;
}

/** `stage:setPack`. */
export type VjSetPackPayload = {
  packId: string | null;
} & VjClientCommandFields;

/** `stage:goClip`. */
export type VjGoClipPayload = { clipId: string | null } & VjClientCommandFields;

/** `stage:setTransition`, a partial patch. */
export type VjSetTransitionPayload = {
  mode?: VjTransitionMode;
  fadeMs?: number;
} & VjClientCommandFields;

/** `stage:setOverlay`, a partial patch. */
export type VjSetOverlayPayload = {
  text?: string;
  style?: VjOverlayStyle;
  isVisible?: boolean;
} & VjClientCommandFields;

/** `stage:setEffects`, a partial patch. */
export type VjSetEffectsPayload = {
  speed?: VjSpeed;
  isMonochrome?: boolean;
  isMirrored?: boolean;
  isHueCycling?: boolean;
  isBlackout?: boolean;
} & VjClientCommandFields;

/** `stage:setStrobe`. */
export type VjSetStrobePayload = {
  isStrobing: boolean;
} & VjClientCommandFields;

/** `stage:setShuffle`, a partial patch. */
export type VjSetShufflePayload = {
  isOn?: boolean;
  intervalKind?: VjShuffleIntervalKind;
  intervalValue?: number;
  bpm?: number;
} & VjClientCommandFields;

/** `screen:advance`: the lead's shuffle report. */
export interface VjScreenAdvancePayload {
  expectedClipSequence: number;
  clipId: string;
}

/** `screen:status`: a screen's fullscreen flag and preload report. */
export interface VjScreenStatusPayload {
  isFullscreen: boolean;
  preload: VjScreenPreload;
}

/** The ack of `session:reauth`: the new `exp` in epoch seconds, or a
 *  transport code. */
export type VjReauthAck =
  { ok: true; exp: number } | { ok: false; code: VjWsTransportCode };

/** `screen:role`: sent to one screen on attach and on every lead change. */
export interface VjScreenRoleFrame {
  isLead: boolean;
}

/** `screens:update`: every screen of the stage, sorted by `number`. */
export interface VjScreensUpdateFrame {
  screens: VjScreenStatus[];
}

/** Every frame a client may send on `/vj`. */
export const VJ_CLIENT_FRAME_NAMES = [
  'vj:attach',
  'session:reauth',
  'stage:setPack',
  'stage:goClip',
  'stage:setTransition',
  'stage:setOverlay',
  'stage:setEffects',
  'stage:setStrobe',
  'stage:setShuffle',
  'screen:advance',
  'screen:status',
] as const;
export type VjClientFrameName = (typeof VJ_CLIENT_FRAME_NAMES)[number];

/** Every frame the server sends on `/vj`. */
export const VJ_SERVER_FRAME_NAMES = [
  'stage:state',
  'screen:role',
  'screens:update',
  'library:changed',
  'exception',
] as const;
export type VjServerFrameName = (typeof VJ_SERVER_FRAME_NAMES)[number];

/** The seven remote commands, each carrying `VjClientCommandFields`. */
export const VJ_REMOTE_COMMAND_NAMES = [
  'stage:setPack',
  'stage:goClip',
  'stage:setTransition',
  'stage:setOverlay',
  'stage:setEffects',
  'stage:setStrobe',
  'stage:setShuffle',
] as const;
export type VjRemoteCommandName = (typeof VJ_REMOTE_COMMAND_NAMES)[number];

/** The `domainCode` values an `exception` frame may carry. */
export const VJ_EXCEPTION_DOMAIN_CODES = [
  'vj_not_admin',
  'vj_screen_replaced',
] as const;
export type VjExceptionDomainCode = (typeof VJ_EXCEPTION_DOMAIN_CODES)[number];

/** The in-process event the library service emits after a committed change;
 *  the gateway relays it to `vj:library` and applies it to every stage. */
export const VJ_LIBRARY_CHANGED = 'vj.library.changed';
