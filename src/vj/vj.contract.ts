/**
 * VJ wire contract v2: the backend source of truth for the shared constants,
 * the effects, generator and transition catalogs, the live stage state, the
 * beat and clock helpers, the screen status and every `/vj` socket frame.
 * `queerpulse/src/shared/contracts/vj.ts` mirrors this file name for name and
 * value for value. Contract `QUEERPULSE-VJ-V2-CONTRACT-2026-11-06.md`,
 * sections 1, 3 and 7, over `QUEERPULSE-VJ-CONTRACT-2026-11-05.md`. This
 * module imports nothing at runtime.
 */

/** Bumped when a frame or state shape changes incompatibly. */
export const VJ_CONTRACT_VERSION = 2;

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

/** Playback rates a remote may pick; GIFs ignore them. */
export const VJ_SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4] as const;
export type VjSpeed = (typeof VJ_SPEEDS)[number];

/** How the screens move from one source to the next. */
export const VJ_TRANSITION_IDS = [
  'fade',
  'cut',
  'dipBlack',
  'dipWhite',
  'wipeLeft',
  'wipeRight',
  'wipeRadial',
  'iris',
  'zoomBlur',
  'glitch',
  'lumaFade',
] as const;
export type VjTransitionId = (typeof VJ_TRANSITION_IDS)[number];

/** Whether a transition length counts milliseconds or beats of the tempo. */
export const VJ_TRANSITION_LENGTH_UNITS = ['ms', 'beats'] as const;
export type VjTransitionLengthUnit =
  (typeof VJ_TRANSITION_LENGTH_UNITS)[number];

/** The beat counts a beats transition length may take. */
export const VJ_TRANSITION_BEAT_COUNTS = [1, 2, 4, 8, 16] as const;
export type VjTransitionBeatCount = (typeof VJ_TRANSITION_BEAT_COUNTS)[number];

/** How overlay text is drawn. */
export const VJ_OVERLAY_STYLES = [
  'big',
  'ticker',
  'neon',
  'outline',
  'typewriter',
  'glitch',
  'stacked',
  'slanted',
] as const;
export type VjOverlayStyle = (typeof VJ_OVERLAY_STYLES)[number];

/** Where overlay text sits on the screen. */
export const VJ_OVERLAY_POSITIONS = ['top', 'center', 'bottom'] as const;
export type VjOverlayPosition = (typeof VJ_OVERLAY_POSITIONS)[number];

/** Overlay text sizes. */
export const VJ_OVERLAY_SIZES = ['s', 'm', 'l', 'xl'] as const;
export type VjOverlaySize = (typeof VJ_OVERLAY_SIZES)[number];

/** Palette names. The screen maps each to a `--vj-palette-<name>` token. */
export const VJ_COLOR_TOKENS = [
  'cream',
  'coral',
  'jade',
  'amber',
  'violet',
  'sky',
  'rose',
  'plum',
] as const;
export type VjColorToken = (typeof VJ_COLOR_TOKENS)[number];

/** Duotone variants: shadow colour, then highlight colour, both from VJ_COLOR_TOKENS. */
export const VJ_DUOTONE_PAIRS = [
  'plum-coral',
  'violet-amber',
  'sky-rose',
  'jade-cream',
  'plum-jade',
] as const;
export type VjDuotonePair = (typeof VJ_DUOTONE_PAIRS)[number];

/** The flags the pride grade and the flag wave generator draw. */
export const VJ_PRIDE_FLAGS = [
  'rainbow',
  'trans',
  'bi',
  'lesbian',
  'nonbinary',
  'progress',
] as const;
export type VjPrideFlag = (typeof VJ_PRIDE_FLAGS)[number];

/** Where the logo sits. */
export const VJ_LOGO_CORNERS = [
  'topLeft',
  'topRight',
  'bottomLeft',
  'bottomRight',
] as const;
export type VjLogoCorner = (typeof VJ_LOGO_CORNERS)[number];

/** What the event card shows: a QR code or the next event's details. */
export const VJ_EVENT_CARD_KINDS = ['qr', 'nextEvent'] as const;
export type VjEventCardKind = (typeof VJ_EVENT_CARD_KINDS)[number];

/** How the mix layer blends over the live source. */
export const VJ_BLEND_MODES = [
  'normal',
  'screen',
  'multiply',
  'difference',
  'add',
  'lighten',
] as const;
export type VjBlendMode = (typeof VJ_BLEND_MODES)[number];

/** The grid a quantized change lands on. */
export const VJ_QUANTIZE_MODES = ['off', 'beat', 'bar'] as const;
export type VjQuantize = (typeof VJ_QUANTIZE_MODES)[number];

/** Where the tempo came from. */
export const VJ_TEMPO_SOURCES = ['manual', 'tap', 'mic'] as const;
export type VjTempoSource = (typeof VJ_TEMPO_SOURCES)[number];

/** Which clips the shuffle draws from. */
export const VJ_SHUFFLE_SOURCES = ['pack', 'favorites'] as const;
export type VjShuffleSource = (typeof VJ_SHUFFLE_SOURCES)[number];

/** How a clip plays between its loop points. */
export const VJ_LOOP_MODES = ['loop', 'pingPong'] as const;
export type VjLoopMode = (typeof VJ_LOOP_MODES)[number];

/** The renderer a screen draws with. */
export const VJ_RENDERERS = ['webgl2', 'dom'] as const;
export type VjRenderer = (typeof VJ_RENDERERS)[number];

/** Beats in one bar of the tempo grid. */
export const VJ_BEATS_PER_BAR = 4;

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
  /** Bounds of a transition length in the 'ms' unit. */
  fadeMsMin: 0,
  fadeMsMax: 4000,
  fadeMsDefault: 800,
  overlayTextMax: 80,
  shuffleSecondsMin: 2,
  shuffleSecondsMax: 60,
  shuffleSecondsDefault: 8,
  shuffleBeatsDefault: 8,
  /** Bounds of `tempo.bpm`. */
  bpmMin: 60,
  bpmMax: 200,
  bpmDefault: 124,
  strobeMaxFlashesPerSecond: 3,
  strobeMaxDurationMs: 10_000,
  /** Lifetime of a preload URL from GET /admin/vj/packs/:id/media. */
  mediaUrlTtlSeconds: 900,
  /** Most ids in one `clipIds` query. */
  mediaClipIdsMax: 200,
  /** 512 KB, the `vj_preview` kind cap. */
  previewMaxBytes: 524_288,
  /** Preview longest edge in pixels. */
  previewLongEdgePx: 240,
  /** Preview length the browser records. */
  previewDurationMs: 2000,
  /** Smallest playable span between loop points. */
  loopMinLengthMs: 250,
  /** Effect and mix amounts are stored rounded to this step. */
  amountStep: 0.01,
  /** Most effect settings with isOn true at once. */
  effectsOnMax: 8,
  overlayHideAfterMsMin: 1000,
  overlayHideAfterMsMax: 600_000,
  countdownLabelMax: 40,
  /** A countdown target lies 1 s to 24 h after the server receives it. */
  countdownLeadMsMin: 1000,
  countdownLeadMsMax: 86_400_000,
  /** How long a finished countdown shows zero before the server hides it. */
  countdownHoldMs: 10_000,
  recentClipsMax: 8,
  excludedClipIdsMax: 200,
  screenOverridesMax: 16,
  identifyDurationMs: 3000,
  sceneNameMax: 60,
  scenesMax: 200,
  /** Serialised `look` JSON, in bytes (UTF-8). */
  sceneLookMaxBytes: 16_384,
  setlistNameMax: 60,
  setlistsMax: 50,
  setlistItemsMax: 100,
  /** A remote's downbeatAt lies within this many ms of the server's clock. */
  downbeatSkewMsMax: 60_000,
  /** Earliest a quantized change may land after the server receives it. */
  quantizeMinLeadMs: 150,
  /** The lead sends a quantized shuffle advance this early. */
  quantizedAdvanceEarlyMs: 300,
  micConfidenceMin: 0.6,
  micTempoMinIntervalMs: 2000,
  micBpmDeltaMin: 0.5,
  micPhaseDriftMsMin: 40,
  upcomingEventsMax: 50,
} as const;

/** The effect groups of the catalog. */
export const VJ_EFFECT_GROUPS = [
  'color',
  'texture',
  'geometry',
  'time',
  'beat',
] as const;
export type VjEffectGroup = (typeof VJ_EFFECT_GROUPS)[number];

/** Catalog order. Settings objects keep their keys in this order (section 3.6). */
export const VJ_EFFECT_IDS = [
  'monochrome',
  'invert',
  'saturate',
  'contrast',
  'tint',
  'duotone',
  'prideGrade',
  'thermal',
  'hueCycle',
  'hueShift',
  'vhs',
  'filmGrain',
  'scanlines',
  'crt',
  'rgbSplit',
  'pixelate',
  'halftone',
  'glitch',
  'dream',
  'vignette',
  'lightLeaks',
  'mirror',
  'kaleidoscope',
  'tile',
  'kenBurns',
  'rotate',
  'zoomPulse',
  'mask',
  'freeze',
  'reverse',
  'pingPong',
  'stutter',
  'echo',
  'beatPulse',
] as const;
export type VjEffectId = (typeof VJ_EFFECT_IDS)[number];

/** One effect's fixed description in the catalog. */
export interface VjEffectCatalogEntry {
  group: VjEffectGroup;
  /** Allowed variant values; empty when the effect has none. */
  variants: readonly string[];
  /** The first variant, or null when there are none. */
  defaultVariant: string | null;
  /** 0..1, a multiple of 0.01. */
  defaultAmount: number;
  /** False hides the amount control; the amount stays at defaultAmount. */
  isAmountAdjustable: boolean;
  /** Turning one on turns the others in the same group off. */
  exclusiveGroup: 'playhead' | null;
  /** Its brightness changes draw from the flash governor (design 5). */
  isFlashCapable: boolean;
  /** The DOM fallback renderer can draw it. */
  isDomCapable: boolean;
  /** It follows tempo phase (for invert and rgbSplit, in the "beat" variant only). */
  isBeatSynced: boolean;
  /** It follows the local mic level when that screen has the mic on. */
  isAudioReactive: boolean;
}

/** One effect's setting on the stage. */
export interface VjEffectSetting {
  isOn: boolean;
  /** 0..1, a multiple of 0.01. */
  amount: number;
  /** One of the entry's variants; null exactly when the entry has none. */
  variant: string | null;
}
export type VjEffectSettings = Partial<Record<VjEffectId, VjEffectSetting>>;

/** Every effect a screen can draw, in catalog order. */
export const VJ_EFFECT_CATALOG: Readonly<
  Record<VjEffectId, VjEffectCatalogEntry>
> = {
  monochrome: {
    group: 'color',
    variants: [],
    defaultVariant: null,
    defaultAmount: 1,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  invert: {
    group: 'color',
    variants: ['steady', 'beat'],
    defaultVariant: 'steady',
    defaultAmount: 1,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: true,
    isDomCapable: true,
    isBeatSynced: true,
    isAudioReactive: false,
  },
  saturate: {
    group: 'color',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  contrast: {
    group: 'color',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  tint: {
    group: 'color',
    variants: VJ_COLOR_TOKENS,
    defaultVariant: 'coral',
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  duotone: {
    group: 'color',
    variants: VJ_DUOTONE_PAIRS,
    defaultVariant: 'plum-coral',
    defaultAmount: 1,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  prideGrade: {
    group: 'color',
    variants: VJ_PRIDE_FLAGS,
    defaultVariant: 'rainbow',
    defaultAmount: 0.6,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  thermal: {
    group: 'color',
    variants: [],
    defaultVariant: null,
    defaultAmount: 1,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  hueCycle: {
    group: 'color',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  hueShift: {
    group: 'color',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  vhs: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.6,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  filmGrain: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.4,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  scanlines: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  crt: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.6,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  rgbSplit: {
    group: 'texture',
    variants: ['steady', 'beat'],
    defaultVariant: 'steady',
    defaultAmount: 0.4,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: true,
    isAudioReactive: true,
  },
  pixelate: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  halftone: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  glitch: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.4,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: true,
    isDomCapable: false,
    isBeatSynced: true,
    isAudioReactive: true,
  },
  dream: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  vignette: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  lightLeaks: {
    group: 'texture',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  mirror: {
    group: 'geometry',
    variants: ['horizontal', 'vertical', 'quad'],
    defaultVariant: 'horizontal',
    defaultAmount: 1,
    isAmountAdjustable: false,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  kaleidoscope: {
    group: 'geometry',
    variants: ['2', '4', '6', '8'],
    defaultVariant: '6',
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  tile: {
    group: 'geometry',
    variants: ['2x2', '3x3'],
    defaultVariant: '2x2',
    defaultAmount: 1,
    isAmountAdjustable: false,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  kenBurns: {
    group: 'geometry',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  rotate: {
    group: 'geometry',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.25,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  zoomPulse: {
    group: 'geometry',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: true,
    isAudioReactive: true,
  },
  mask: {
    group: 'geometry',
    variants: ['circle', 'heart', 'star'],
    defaultVariant: 'circle',
    defaultAmount: 0.8,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  freeze: {
    group: 'time',
    variants: [],
    defaultVariant: null,
    defaultAmount: 1,
    isAmountAdjustable: false,
    exclusiveGroup: 'playhead',
    isFlashCapable: false,
    isDomCapable: true,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  reverse: {
    group: 'time',
    variants: [],
    defaultVariant: null,
    defaultAmount: 1,
    isAmountAdjustable: false,
    exclusiveGroup: 'playhead',
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  pingPong: {
    group: 'time',
    variants: [],
    defaultVariant: null,
    defaultAmount: 1,
    isAmountAdjustable: false,
    exclusiveGroup: 'playhead',
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  stutter: {
    group: 'time',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: true,
    isAudioReactive: false,
  },
  echo: {
    group: 'time',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: false,
    isDomCapable: false,
    isBeatSynced: false,
    isAudioReactive: false,
  },
  beatPulse: {
    group: 'beat',
    variants: [],
    defaultVariant: null,
    defaultAmount: 0.5,
    isAmountAdjustable: true,
    exclusiveGroup: null,
    isFlashCapable: true,
    isDomCapable: true,
    isBeatSynced: true,
    isAudioReactive: true,
  },
};

/** Sources a screen draws without a clip. */
export const VJ_GENERATOR_IDS = [
  'gradientField',
  'plasma',
  'starfield',
  'prideFlagWave',
  'tunnel',
] as const;
export type VjGeneratorId = (typeof VJ_GENERATOR_IDS)[number];

/** One generator's fixed description in the catalog. */
export interface VjGeneratorCatalogEntry {
  variants: readonly string[];
  defaultVariant: string | null;
  /** The DOM fallback can draw it; any other generator draws as gradientField there. */
  isDomCapable: boolean;
  isBeatSynced: boolean;
}

/** Every generator a screen can draw. */
export const VJ_GENERATOR_CATALOG: Readonly<
  Record<VjGeneratorId, VjGeneratorCatalogEntry>
> = {
  gradientField: {
    variants: [],
    defaultVariant: null,
    isDomCapable: true,
    isBeatSynced: false,
  },
  plasma: {
    variants: [],
    defaultVariant: null,
    isDomCapable: false,
    isBeatSynced: false,
  },
  starfield: {
    variants: [],
    defaultVariant: null,
    isDomCapable: false,
    isBeatSynced: true,
  },
  prideFlagWave: {
    variants: VJ_PRIDE_FLAGS,
    defaultVariant: 'rainbow',
    isDomCapable: true,
    isBeatSynced: true,
  },
  tunnel: {
    variants: [],
    defaultVariant: null,
    isDomCapable: false,
    isBeatSynced: true,
  },
};

/** One transition's fixed description in the catalog. */
export interface VjTransitionCatalogEntry {
  isFlashCapable: boolean;
  /** The DOM fallback can draw it; any other transition draws as fade there. */
  isDomCapable: boolean;
}

/** Every transition a screen can draw. */
export const VJ_TRANSITION_CATALOG: Readonly<
  Record<VjTransitionId, VjTransitionCatalogEntry>
> = {
  fade: { isFlashCapable: false, isDomCapable: true },
  cut: { isFlashCapable: false, isDomCapable: true },
  dipBlack: { isFlashCapable: false, isDomCapable: true },
  dipWhite: { isFlashCapable: true, isDomCapable: true },
  wipeLeft: { isFlashCapable: false, isDomCapable: true },
  wipeRight: { isFlashCapable: false, isDomCapable: true },
  wipeRadial: { isFlashCapable: false, isDomCapable: true },
  iris: { isFlashCapable: false, isDomCapable: true },
  zoomBlur: { isFlashCapable: false, isDomCapable: false },
  glitch: { isFlashCapable: true, isDomCapable: false },
  lumaFade: { isFlashCapable: false, isDomCapable: false },
};

/** A transition's length, in milliseconds or in beats of the tempo. */
export interface VjTransitionLength {
  unit: VjTransitionLengthUnit;
  /** 'ms': integer 0..4000. 'beats': one of 1, 2, 4, 8, 16. */
  value: number;
}

/** How the screens move between sources. */
export interface VjTransition {
  /** Default 'fade'. */
  mode: VjTransitionId;
  /** Default { unit: 'ms', value: 800 }; 'cut' ignores it. */
  length: VjTransitionLength;
}

/** Text drawn over the clips. */
export interface VjOverlay {
  /** Trimmed, 0..80 code points, default ''. */
  text: string;
  /** Default 'big'. */
  style: VjOverlayStyle;
  /** Default false; true needs non-blank text. */
  isVisible: boolean;
  /** Default 'center'. */
  position: VjOverlayPosition;
  /** Default 'l'. */
  size: VjOverlaySize;
  /** Default 'cream'. */
  colorToken: VjColorToken;
  /** Server epoch ms the server hides the overlay; null for no auto-hide. Null while hidden. */
  hideAt: number | null;
}

/** A countdown drawn over the clips. */
export interface VjCountdown {
  /** Default false; true needs targetAt in the future. */
  isVisible: boolean;
  /** Server epoch ms the countdown reaches zero; null until set. */
  targetAt: number | null;
  /** Trimmed, 0..40 code points, default ''. */
  label: string;
}

/** The QueerPulse logo drawn in one corner. */
export interface VjLogo {
  /** Default false. */
  isVisible: boolean;
  /** Default 'bottomRight'. */
  corner: VjLogoCorner;
}

/** The card for the event the active pack links. */
export interface VjEventCard {
  /** Default false; true needs the active pack to link an event. */
  isVisible: boolean;
  /** Default 'qr'. */
  kind: VjEventCardKind;
}

/** Effects the screens apply to whatever plays. */
export interface VjEffects {
  /** Default 1; GIFs ignore it. */
  speed: VjSpeed;
  /** Default {}; canonical form in section 3.6. */
  settings: VjEffectSettings;
  /** Default false; the server turns it off 10 s after it went on. */
  isStrobing: boolean;
  /** Default false. */
  isBlackout: boolean;
  /** Server epoch ms the strobe started (its applyAt, or receipt when null); null while off. */
  strobeStartedAt: number | null;
}

/** The mix layer over the live source. */
export interface VjMix {
  /** Default null. */
  clipId: string | null;
  /** 0 shows only the live source, 1 only the mix clip. Multiple of 0.01. Default 0. */
  amount: number;
  /** Default 'normal'. */
  blendMode: VjBlendMode;
}

/** The global tempo grid every beat-synced thing follows. */
export interface VjTempo {
  /** 60..200, rounded to one decimal place; default 124. */
  bpm: number;
  /** Server epoch ms (integer) of a "1" (the first beat of a bar). */
  downbeatAt: number;
  /** Default 'off'. */
  quantize: VjQuantize;
  /** Default 'manual'. */
  source: VjTempoSource;
}

/** The lead screen's automatic clip changes. */
export interface VjShuffle {
  /** Default false. */
  isOn: boolean;
  /** Default 'seconds'. */
  intervalKind: VjShuffleIntervalKind;
  /** 'seconds': integer 2..60. 'beats': one of 4, 8, 16, 32. Default 8 (either kind). */
  intervalValue: number;
  /** Default 'pack'. */
  source: VjShuffleSource;
  /** Clips of the active pack the shuffle skips; at most 200; cleared on a pack change. */
  excludedClipIds: string[];
}

/** The source one screen shows while it leaves the main look. */
export interface VjScreenOverride {
  /** Exactly one of clipId and generatorId is non-null. */
  clipId: string | null;
  generatorId: VjGeneratorId | null;
  /** Null unless generatorId has variants. */
  generatorVariant: string | null;
}

/** The whole live stage of one admin, broadcast in full on every change. */
export interface VjStageState {
  /** Random uuid minted when the server creates this stage in memory. A new
   *  value means the backend restarted or the stage was evicted. */
  stageEpoch: string;
  /** Starts at 0 for a fresh stage; +1 on every applied change. */
  revision: number;
  /** +1 whenever the live source or activePackId is set (v1 rule, now also for generators). */
  clipSequence: number;
  /** Default null. */
  activePackId: string | null;
  /** Setting one of liveClipId and liveGeneratorId clears the other. Both null shows black. */
  liveClipId: string | null;
  /** Default null. */
  liveGeneratorId: VjGeneratorId | null;
  /** Default null; non-null only for a generator with variants. */
  liveGeneratorVariant: string | null;
  /** Server epoch ms the current live source went live (its applyAt, or receipt); null when nothing is live. */
  liveSince: number | null;
  transition: VjTransition;
  overlay: VjOverlay;
  countdown: VjCountdown;
  logo: VjLogo;
  eventCard: VjEventCard;
  effects: VjEffects;
  mix: VjMix;
  tempo: VjTempo;
  shuffle: VjShuffle;
  /** Last 8 clips that went live, newest first, each id once. In memory only. */
  recentClipIds: string[];
  /** Keyed by screenId; a screen without an entry follows the main look. */
  screenOverrides: Record<string, VjScreenOverride>;
  /** Default null. */
  activeSetlistId: string | null;
  /** Index of the set list item recalled last; null when armed and nothing recalled yet. */
  setlistIndex: number | null;
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
  | 'liveGeneratorId'
  | 'liveGeneratorVariant'
  | 'transition'
  | 'overlay'
  | 'countdown'
  | 'logo'
  | 'eventCard'
  | 'effects'
  | 'mix'
  | 'tempo'
  | 'shuffle'
  | 'activeSetlistId'
  | 'setlistIndex'
>;

/** Why a `stage:state` frame was sent. */
export const VJ_STAGE_CAUSES = [
  'attach',
  'restore',
  'command',
  'shuffle',
  'strobe_timeout',
  'library',
  'mic_tempo',
  'overlay_timeout',
  'countdown_end',
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
    liveGeneratorId: null,
    liveGeneratorVariant: null,
    liveSince: null,
    transition: {
      mode: 'fade',
      length: { unit: 'ms', value: VJ_LIMITS.fadeMsDefault },
    },
    overlay: {
      text: '',
      style: 'big',
      isVisible: false,
      position: 'center',
      size: 'l',
      colorToken: 'cream',
      hideAt: null,
    },
    countdown: { isVisible: false, targetAt: null, label: '' },
    logo: { isVisible: false, corner: 'bottomRight' },
    eventCard: { isVisible: false, kind: 'qr' },
    effects: {
      speed: 1,
      settings: {},
      isStrobing: false,
      isBlackout: false,
      strobeStartedAt: null,
    },
    mix: { clipId: null, amount: 0, blendMode: 'normal' },
    tempo: {
      bpm: VJ_LIMITS.bpmDefault,
      downbeatAt: now,
      quantize: 'off',
      source: 'manual',
    },
    shuffle: {
      isOn: false,
      intervalKind: 'seconds',
      intervalValue: VJ_LIMITS.shuffleSecondsDefault,
      source: 'pack',
      excludedClipIds: [],
    },
    recentClipIds: [],
    screenOverrides: {},
    activeSetlistId: null,
    setlistIndex: null,
    updatedAt: now,
  };
}

/** The setting an effect has now: its entry, or the catalog's off default. */
export function vjEffectSettingOf(
  effects: VjEffects,
  effectId: VjEffectId,
): VjEffectSetting {
  const entry = VJ_EFFECT_CATALOG[effectId];
  return (
    effects.settings[effectId] ?? {
      isOn: false,
      amount: entry.defaultAmount,
      variant: entry.defaultVariant,
    }
  );
}

/** Rounds an amount to the 0.01 step. */
export function roundVjAmount(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Milliseconds of one beat. */
export function vjBeatMs(bpm: number): number {
  return 60000 / bpm;
}

/** Where a server time falls on the tempo grid. */
export interface VjBeatPosition {
  /** Whole beats since tempo.downbeatAt; negative before it. */
  beatIndex: number;
  barIndex: number;
  /** 0..3; 0 is the "1". */
  beatInBar: number;
  /** 0 (on the beat) up to but excluding 1. */
  phase: number;
}

/** Half a millisecond: boundaries are rounded to whole ms, so a time within
 *  this of a fractional boundary counts as on it. */
const VJ_BOUNDARY_TOLERANCE_MS = 0.5;

/** The beat, bar and phase of `serverTime` on the tempo grid; a time within
 *  half a millisecond of a beat reads as on that beat. */
export function vjBeatPositionAt(
  tempo: VjTempo,
  serverTime: number,
): VjBeatPosition {
  const beatMs = vjBeatMs(tempo.bpm);
  const msSinceDownbeat = serverTime - tempo.downbeatAt;
  const beatIndex = Math.floor(
    (msSinceDownbeat + VJ_BOUNDARY_TOLERANCE_MS) / beatMs,
  );
  return {
    beatIndex,
    barIndex: Math.floor(beatIndex / VJ_BEATS_PER_BAR),
    beatInBar:
      ((beatIndex % VJ_BEATS_PER_BAR) + VJ_BEATS_PER_BAR) % VJ_BEATS_PER_BAR,
    phase: Math.max(0, msSinceDownbeat / beatMs - beatIndex),
  };
}

/** The first beat (or bar) boundary at or after `earliest`, integer server ms.
 *  A boundary this returns, fed back as `earliest`, answers itself. */
export function vjNextBoundaryAt(
  tempo: VjTempo,
  unit: 'beat' | 'bar',
  earliest: number,
): number {
  const unitMs = vjBeatMs(tempo.bpm) * (unit === 'bar' ? VJ_BEATS_PER_BAR : 1);
  const unitsAhead = Math.ceil(
    (earliest - tempo.downbeatAt - VJ_BOUNDARY_TOLERANCE_MS) / unitMs,
  );
  return Math.round(tempo.downbeatAt + unitsAhead * unitMs);
}

/** The last "1" at or before `serverTime`, integer server ms. A bar boundary
 *  this returns answers itself. */
export function vjLastDownbeatAt(tempo: VjTempo, serverTime: number): number {
  const barMs = vjBeatMs(tempo.bpm) * VJ_BEATS_PER_BAR;
  const barsSinceDownbeat = Math.floor(
    (serverTime - tempo.downbeatAt + VJ_BOUNDARY_TOLERANCE_MS) / barMs,
  );
  return Math.round(tempo.downbeatAt + barsSinceDownbeat * barMs);
}

/** Where a quantized change lands when the server receives it at `now`; null when quantize is off. */
export function vjQuantizedApplyAt(tempo: VjTempo, now: number): number | null {
  if (tempo.quantize === 'off') {
    return null;
  }
  return vjNextBoundaryAt(
    tempo,
    tempo.quantize,
    now + VJ_LIMITS.quantizeMinLeadMs,
  );
}

/** A transition's length in ms; beats use tempo.bpm; 'cut' is 0. */
export function vjTransitionLengthMs(
  transition: VjTransition,
  tempo: VjTempo,
): number {
  if (transition.mode === 'cut') {
    return 0;
  }
  if (transition.length.unit === 'ms') {
    return transition.length.value;
  }
  return Math.round(transition.length.value * vjBeatMs(tempo.bpm));
}

/** Blackout fades over the transition length, capped at 4000 ms. */
export function vjBlackoutFadeMs(
  transition: VjTransition,
  tempo: VjTempo,
): number {
  return Math.min(VJ_LIMITS.fadeMsMax, vjTransitionLengthMs(transition, tempo));
}

/** The shuffle interval in milliseconds, computed identically on screen,
 *  remote and demo: seconds give `intervalValue * 1000`; beats give
 *  `Math.round(intervalValue * 60000 / tempo.bpm)`. */
export function vjShuffleIntervalMs(
  shuffle: VjShuffle,
  tempo: VjTempo,
): number {
  if (shuffle.intervalKind === 'seconds') {
    return shuffle.intervalValue * 1000;
  }
  return Math.round((shuffle.intervalValue * 60000) / tempo.bpm);
}

/** Strobe flashes per second: one flash per beat, capped at 3 per second at
 *  any tempo. Callers pass tempo.bpm. */
export function vjStrobeFlashesPerSecond(bpm: number): number {
  return Math.min(VJ_LIMITS.strobeMaxFlashesPerSecond, bpm / 60);
}

/** Whether a change switches what the screens show, so quantize applies (section 7.4).
 *  A clipSequence bump with the same pack is a re-tap; a pack change alone shows nothing new. */
export function vjIsQuantizedChange(
  previous: VjStageState,
  next: VjStageState,
): boolean {
  return (
    previous.liveClipId !== next.liveClipId ||
    previous.liveGeneratorId !== next.liveGeneratorId ||
    previous.liveGeneratorVariant !== next.liveGeneratorVariant ||
    (previous.clipSequence !== next.clipSequence &&
      previous.activePackId === next.activePackId) ||
    previous.mix.clipId !== next.mix.clipId ||
    previous.overlay.isVisible !== next.overlay.isVisible ||
    JSON.stringify(previous.screenOverrides) !==
      JSON.stringify(next.screenOverrides)
  );
}

/** A uuid in canonical (lowercase) form; null stays null. */
function lowercaseVjId(id: string | null): string | null {
  return id === null ? null : id.toLowerCase();
}

/** Ascending code unit order, the same on every runtime (no locale). */
function compareVjIds(first: string, second: string): number {
  if (first < second) {
    return -1;
  }
  return first > second ? 1 : 0;
}

/** Whether a setting equals its catalog off default. */
function isVjOffDefaultSetting(
  setting: VjEffectSetting,
  entry: VjEffectCatalogEntry,
): boolean {
  return (
    !setting.isOn &&
    setting.amount === entry.defaultAmount &&
    setting.variant === entry.defaultVariant
  );
}

/** Effect settings in catalog order with the off defaults dropped, each a
 *  fresh literal. Ids outside the catalog are dropped too. */
function canonicalVjEffectSettings(
  settings: VjEffectSettings,
): VjEffectSettings {
  const canonicalSettings: VjEffectSettings = {};
  for (const effectId of VJ_EFFECT_IDS) {
    const setting = settings[effectId];
    if (
      setting === undefined ||
      isVjOffDefaultSetting(setting, VJ_EFFECT_CATALOG[effectId])
    ) {
      continue;
    }
    canonicalSettings[effectId] = {
      isOn: setting.isOn,
      amount: setting.amount,
      variant: setting.variant,
    };
  }
  return canonicalSettings;
}

/** Screen overrides keyed by lowercased screen id in ascending order. */
function canonicalVjScreenOverrides(
  screenOverrides: Record<string, VjScreenOverride>,
): Record<string, VjScreenOverride> {
  const canonicalOverrides: Record<string, VjScreenOverride> = {};
  const entries = Object.entries(screenOverrides)
    .map(
      ([screenId, override]) =>
        [screenId.toLowerCase(), override] as [string, VjScreenOverride],
    )
    .sort(([firstId], [secondId]) => compareVjIds(firstId, secondId));
  for (const [screenId, override] of entries) {
    canonicalOverrides[screenId] = {
      clipId: lowercaseVjId(override.clipId),
      generatorId: override.generatorId,
      generatorVariant: override.generatorVariant,
    };
  }
  return canonicalOverrides;
}

/** Excluded clip ids lowercased, deduplicated and sorted ascending. */
function canonicalVjExcludedClipIds(clipIds: string[]): string[] {
  const lowercased = clipIds.map((clipId) => clipId.toLowerCase());
  return [...new Set(lowercased)].sort(compareVjIds);
}

/** The canonical form of a state (section 3.6): every nested object rebuilt
 *  as a fresh literal in contract 3.4 field order, settings in catalog order
 *  with off defaults dropped, overrides sorted by screen id, excluded ids
 *  lowercased, deduplicated and sorted, every uuid lowercased. */
export function canonicalVjStageState(state: VjStageState): VjStageState {
  return {
    stageEpoch: state.stageEpoch.toLowerCase(),
    revision: state.revision,
    clipSequence: state.clipSequence,
    activePackId: lowercaseVjId(state.activePackId),
    liveClipId: lowercaseVjId(state.liveClipId),
    liveGeneratorId: state.liveGeneratorId,
    liveGeneratorVariant: state.liveGeneratorVariant,
    liveSince: state.liveSince,
    transition: {
      mode: state.transition.mode,
      length: {
        unit: state.transition.length.unit,
        value: state.transition.length.value,
      },
    },
    overlay: {
      text: state.overlay.text,
      style: state.overlay.style,
      isVisible: state.overlay.isVisible,
      position: state.overlay.position,
      size: state.overlay.size,
      colorToken: state.overlay.colorToken,
      hideAt: state.overlay.hideAt,
    },
    countdown: {
      isVisible: state.countdown.isVisible,
      targetAt: state.countdown.targetAt,
      label: state.countdown.label,
    },
    logo: { isVisible: state.logo.isVisible, corner: state.logo.corner },
    eventCard: {
      isVisible: state.eventCard.isVisible,
      kind: state.eventCard.kind,
    },
    effects: {
      speed: state.effects.speed,
      settings: canonicalVjEffectSettings(state.effects.settings),
      isStrobing: state.effects.isStrobing,
      isBlackout: state.effects.isBlackout,
      strobeStartedAt: state.effects.strobeStartedAt,
    },
    mix: {
      clipId: lowercaseVjId(state.mix.clipId),
      amount: state.mix.amount,
      blendMode: state.mix.blendMode,
    },
    tempo: {
      bpm: state.tempo.bpm,
      downbeatAt: state.tempo.downbeatAt,
      quantize: state.tempo.quantize,
      source: state.tempo.source,
    },
    shuffle: {
      isOn: state.shuffle.isOn,
      intervalKind: state.shuffle.intervalKind,
      intervalValue: state.shuffle.intervalValue,
      source: state.shuffle.source,
      excludedClipIds: canonicalVjExcludedClipIds(
        state.shuffle.excludedClipIds,
      ),
    },
    recentClipIds: state.recentClipIds.map((clipId) => clipId.toLowerCase()),
    screenOverrides: canonicalVjScreenOverrides(state.screenOverrides),
    activeSetlistId: lowercaseVjId(state.activeSetlistId),
    setlistIndex: state.setlistIndex,
    updatedAt: state.updatedAt,
  };
}

/** Whether two states hold the same content: their canonical JSON compared
 *  with `revision` and `updatedAt` taken out. */
export function isSameVjStageContent(
  first: VjStageState,
  second: VjStageState,
): boolean {
  const comparable = (state: VjStageState): string =>
    JSON.stringify({
      ...canonicalVjStageState(state),
      revision: 0,
      updatedAt: 0,
    });
  return comparable(first) === comparable(second);
}

/** One clock round trip: an emitted frame and its ack. */
export interface VjClockSample {
  /** Local ms when the frame was emitted. */
  sentAt: number;
  /** Local ms when its ack arrived. */
  receivedAt: number;
  /** The ack's serverNow. */
  serverNow: number;
}

/** How many of the newest samples the offset reads. */
export const VJ_CLOCK_SAMPLES_KEPT = 9;
/** How many of the fastest kept samples the median takes. */
export const VJ_CLOCK_BEST_SAMPLES = 5;
/** Longest round trip a usable sample may have. */
export const VJ_CLOCK_MAX_ROUND_TRIP_MS = 1000;

/** serverNow minus the local midpoint, as the median over the 5 fastest of
 *  the last 9 samples (round trip at most 1000 ms); null with no usable sample. */
export function vjClockOffsetMs(
  samples: readonly VjClockSample[],
): number | null {
  const fastestSamples = samples
    .slice(-VJ_CLOCK_SAMPLES_KEPT)
    .map((sample) => ({
      roundTripMs: sample.receivedAt - sample.sentAt,
      offsetMs: sample.serverNow - (sample.sentAt + sample.receivedAt) / 2,
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.roundTripMs) &&
        Number.isFinite(sample.offsetMs) &&
        sample.roundTripMs >= 0 &&
        sample.roundTripMs <= VJ_CLOCK_MAX_ROUND_TRIP_MS,
    )
    .sort((first, second) => first.roundTripMs - second.roundTripMs)
    .slice(0, VJ_CLOCK_BEST_SAMPLES);
  const offsets = fastestSamples
    .map((sample) => sample.offsetMs)
    .sort((first, second) => first - second);
  const middleIndex = Math.floor(offsets.length / 2);
  const upperMiddle = offsets[middleIndex];
  if (upperMiddle === undefined) {
    return null;
  }
  if (offsets.length % 2 === 1) {
    return upperMiddle;
  }
  const lowerMiddle = offsets[middleIndex - 1] ?? upperMiddle;
  return (lowerMiddle + upperMiddle) / 2;
}

/** A plain object read as a record; anything else answers null. */
function asVjRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** The v1 effect flags and the v2 settings each maps to (section 3.6 table),
 *  in catalog order. */
const VJ_V1_EFFECT_FLAGS: ReadonlyArray<{
  flag: 'isMonochrome' | 'isHueCycling' | 'isMirrored';
  effectId: VjEffectId;
  setting: VjEffectSetting;
}> = [
  {
    flag: 'isMonochrome',
    effectId: 'monochrome',
    setting: { isOn: true, amount: 1, variant: null },
  },
  {
    flag: 'isHueCycling',
    effectId: 'hueCycle',
    setting: { isOn: true, amount: 0.5, variant: null },
  },
  {
    flag: 'isMirrored',
    effectId: 'mirror',
    setting: { isOn: true, amount: 1, variant: 'horizontal' },
  },
];

/** Whether an unknown state record still has a v1 shape anywhere. */
function isVjStageFieldsV1(value: Record<string, unknown>): boolean {
  const transition = asVjRecord(value.transition);
  const overlay = asVjRecord(value.overlay);
  const effects = asVjRecord(value.effects);
  const shuffle = asVjRecord(value.shuffle);
  return (
    !('tempo' in value) ||
    (transition !== null && !('length' in transition)) ||
    (overlay !== null && !('position' in overlay)) ||
    (effects !== null &&
      (!('settings' in effects) ||
        VJ_V1_EFFECT_FLAGS.some(({ flag }) => flag in effects))) ||
    (shuffle !== null && ('bpm' in shuffle || !('source' in shuffle)))
  );
}

/** v1 `effects` with its three flags folded into `settings`. */
function upgradeVjEffectsV1(
  effects: Record<string, unknown>,
): Record<string, unknown> {
  const upgraded: Record<string, unknown> = { ...effects };
  const settings: Record<string, VjEffectSetting> = {};
  for (const { flag, effectId, setting } of VJ_V1_EFFECT_FLAGS) {
    if (effects[flag] === true) {
      settings[effectId] = { ...setting };
    }
    delete upgraded[flag];
  }
  if (!('settings' in effects)) {
    upgraded.settings = settings;
  }
  return upgraded;
}

/** The v1 rows of the section 3.6 table for transition, overlay, effects
 *  and shuffle, each applied only to the shape it maps. */
function upgradeVjNestedFieldsV1(
  upgraded: Record<string, unknown>,
  now: number,
): void {
  const transition = asVjRecord(upgraded.transition);
  if (transition !== null && !('length' in transition)) {
    upgraded.transition = {
      mode: transition.mode,
      length: { unit: 'ms', value: transition.fadeMs },
    };
  }
  const overlay = asVjRecord(upgraded.overlay);
  if (overlay !== null && !('position' in overlay)) {
    upgraded.overlay = {
      ...overlay,
      position: overlay.style === 'ticker' ? 'bottom' : 'center',
      size: 'l',
      colorToken: 'cream',
      hideAt: null,
    };
  }
  const effects = asVjRecord(upgraded.effects);
  if (effects !== null) {
    upgraded.effects = upgradeVjEffectsV1(effects);
  }
  const shuffle = asVjRecord(upgraded.shuffle);
  if (shuffle !== null) {
    const { bpm, ...shuffleWithoutBpm } = shuffle;
    if (!('tempo' in upgraded) && 'bpm' in shuffle) {
      // A v1 bpm that is not a finite number seeds the default tempo.
      upgraded.tempo = {
        bpm:
          typeof bpm === 'number' && Number.isFinite(bpm)
            ? bpm
            : VJ_LIMITS.bpmDefault,
        downbeatAt: now,
        quantize: 'off',
        source: 'manual',
      };
    }
    upgraded.shuffle =
      'source' in shuffle
        ? shuffleWithoutBpm
        : { ...shuffleWithoutBpm, source: 'pack', excludedClipIds: [] };
  }
}

/** The fields v2 added to the state, filled from `createVjStageState` when a
 *  v1 record lacks them. */
const VJ_V2_STAGE_FIELDS = [
  'liveGeneratorId',
  'liveGeneratorVariant',
  'countdown',
  'logo',
  'eventCard',
  'mix',
  'tempo',
  'recentClipIds',
  'screenOverrides',
  'activeSetlistId',
  'setlistIndex',
] as const;

/** Maps v1 state fields to v2 on an unknown record; a v2 record comes back unchanged.
 *  The result still goes through each side's validators. A record counts as
 *  v1 when it lacks `tempo` or any nested object keeps a v1 shape; only then
 *  are missing v2 fields filled, so a v2 restore payload (which leaves out
 *  liveSince, recentClipIds and screenOverrides) passes through untouched. */
export function upgradeVjStageFieldsV1(
  value: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  if (!isVjStageFieldsV1(value)) {
    return value;
  }
  const upgraded: Record<string, unknown> = { ...value };
  upgradeVjNestedFieldsV1(upgraded, now);
  const defaults = createVjStageState('', now) as unknown as Record<
    string,
    unknown
  >;
  for (const field of VJ_V2_STAGE_FIELDS) {
    if (!(field in upgraded)) {
      upgraded[field] = defaults[field];
    }
  }
  if (!('liveSince' in upgraded)) {
    upgraded.liveSince = typeof upgraded.liveClipId === 'string' ? now : null;
  }
  return upgraded;
}

/** The live source a scene recalls. */
export type VjSceneSource =
  | { kind: 'clip'; clipId: string }
  | {
      kind: 'generator';
      generatorId: VjGeneratorId;
      generatorVariant: string | null;
    };

/** A saved look: source, effects, transition, overlay and mix. */
export interface VjSceneLook {
  /** Null keeps whatever is live when the scene is recalled. */
  source: VjSceneSource | null;
  effects: { speed: VjSpeed; settings: VjEffectSettings };
  transition: VjTransition;
  overlay: Omit<VjOverlay, 'hideAt'>;
  mix: VjMix;
}

/** The look a remote saves: the live source (null when nothing is live), the effects, transition, overlay and mix. */
export function vjSceneLookOf(state: VjStageState): VjSceneLook {
  let source: VjSceneSource | null = null;
  if (state.liveClipId !== null) {
    source = { kind: 'clip', clipId: state.liveClipId };
  } else if (state.liveGeneratorId !== null) {
    source = {
      kind: 'generator',
      generatorId: state.liveGeneratorId,
      generatorVariant: state.liveGeneratorVariant,
    };
  }
  return {
    source,
    effects: {
      speed: state.effects.speed,
      settings: canonicalVjEffectSettings(state.effects.settings),
    },
    transition: {
      mode: state.transition.mode,
      length: {
        unit: state.transition.length.unit,
        value: state.transition.length.value,
      },
    },
    overlay: {
      text: state.overlay.text,
      style: state.overlay.style,
      isVisible: state.overlay.isVisible,
      position: state.overlay.position,
      size: state.overlay.size,
      colorToken: state.overlay.colorToken,
    },
    mix: {
      clipId: state.mix.clipId,
      amount: state.mix.amount,
      blendMode: state.mix.blendMode,
    },
  };
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

/** A screen's renderer health, as it reports it. */
export interface VjScreenHealth {
  renderer: VjRenderer;
  /** Frames drawn per second, mean over the last 5 s, 0..240, one decimal. */
  fps: number;
  /** Frames dropped over the last 5 s, integer 0..1 000 000. */
  droppedFrames: number;
  /** Bytes this screen holds in the VJ clip cache, safe integer. */
  cacheBytes: number;
  /** The renderer judges the current effect load too heavy for smooth output. */
  isEffectLoadHigh: boolean;
}

/** Sent only while this screen has the mic on (opt-in on the setup card). */
export interface VjScreenMicReport {
  /** 0..1, two decimals. */
  level: number;
  /** Detected tempo, 60..200; null until confident enough to guess. */
  bpm: number | null;
  /** 0..1. */
  confidence: number;
  /** Server epoch ms of the latest detected beat (local onset time plus the clock offset); null with no beat yet. */
  beatAt: number | null;
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
  /** Null until this screen reports health (or from a screen that never does). */
  health: VjScreenHealth | null;
  /** The lead's shuffle pick for the next advance; null on followers and when shuffle is off. */
  nextClipId: string | null;
  /** Null while the mic is off on this screen. */
  mic: {
    level: number;
    detectedBpm: number | null;
    confidence: number;
  } | null;
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

/** Every code a VJ socket ack can refuse with: the v1 codes in v1 order, then
 *  the v2 codes of contract 7.11, then `vj_server_error`. */
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
  'vj_client_outdated',
  'vj_immediate_not_allowed',
  'vj_transition_length_invalid',
  'vj_overlay_position_invalid',
  'vj_overlay_size_invalid',
  'vj_color_token_invalid',
  'vj_overlay_hide_out_of_range',
  'vj_effect_unknown',
  'vj_effect_amount_invalid',
  'vj_effect_variant_invalid',
  'vj_effect_exclusive_conflict',
  'vj_effects_too_many',
  'vj_generator_invalid',
  'vj_generator_variant_invalid',
  'vj_downbeat_out_of_range',
  'vj_quantize_invalid',
  'vj_tempo_source_invalid',
  'vj_tempo_source_conflict',
  'vj_mic_unavailable',
  'vj_mix_amount_invalid',
  'vj_blend_mode_invalid',
  'vj_mix_empty',
  'vj_shuffle_source_invalid',
  'vj_excluded_clips_invalid',
  'vj_clip_excluded',
  'vj_clip_not_favorite',
  'vj_screen_not_attached',
  'vj_override_invalid',
  'vj_overrides_too_many',
  'vj_scene_not_found',
  'vj_setlist_not_found',
  'vj_setlist_none',
  'vj_setlist_empty',
  'vj_setlist_index_invalid',
  'vj_setlist_start',
  'vj_setlist_end',
  'vj_stale_setlist',
  'vj_countdown_target_conflict',
  'vj_countdown_out_of_range',
  'vj_countdown_target_missing',
  'vj_countdown_label_invalid',
  'vj_countdown_label_too_long',
  'vj_logo_corner_invalid',
  'vj_event_card_kind_invalid',
  'vj_event_card_no_event',
  'vj_server_error',
] as const;
export type VjSocketErrorCode = (typeof VJ_SOCKET_ERROR_CODES)[number];

/** A refused socket frame's acknowledgement. */
export interface VjAckFailure {
  ok: false;
  code: VjSocketErrorCode;
  /** English, for logs; the frontend maps `code` to copy. */
  message: string;
  /** Carried on the codes section 7.11 marks "state", so the sender can snap to it. */
  state?: VjStageState;
  /** Server epoch ms (Date.now()) when the ack was built. */
  serverNow: number;
}

/** The acknowledgement of every client frame but `screen:status`; every one
 *  carries the server's clock. */
export type VjAck<Success extends object = Record<string, never>> =
  ({ ok: true; serverNow: number } & Success) | VjAckFailure;

/** Success ack of every stage command. */
export interface VjCommandSuccess {
  /** The state's revision after this command. */
  revision: number;
  /** True when nothing changed (nothing broadcast, revision unchanged). */
  isNoop: boolean;
  /** Server epoch ms this change lands on screens; null when it applies at once, and on a noop. */
  applyAt: number | null;
}

/** The `vj:attach` payload: a screen names itself and may seed a lost stage. */
export type VjAttachPayload =
  | {
      role: 'screen';
      contractVersion: number;
      screenId: string;
      restoreState: VjStageRestore | null;
    }
  | { role: 'remote'; contractVersion: number };

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
  /** Screen only: this screen's 1-based number ("Screen 2"); null for a remote. */
  screenNumber: number | null;
}

/** The `stage:state` frame. */
export interface VjStageFrame {
  state: VjStageState;
  cause: VjStageCause;
  /** The clientId whose command caused this; null for every other cause. */
  sourceClientId: string | null;
  /** Server epoch ms every client applies this state at; null applies at once. */
  applyAt: number | null;
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
  'clip_favorite_changed',
  'clip_defaults_changed',
  'clip_preview_changed',
  'pack_event_changed',
  'scene_created',
  'scene_updated',
  'scene_deleted',
  'scenes_reordered',
  'setlist_created',
  'setlist_renamed',
  'setlist_items_changed',
  'setlist_deleted',
  'setlists_reordered',
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
  /** The scene touched, when one is. */
  sceneId: string | null;
  /** The set list touched, when one is. */
  setlistId: string | null;
  /** Every set list whose items changed (a scene delete lists each set list that held it). */
  setlistIds: string[];
  /** pack_event_changed only: the pack's event id after the change; null otherwise. */
  eventId: string | null;
}

/** The pair every remote command carries (v1 6.5): a per-page uuid and a
 *  positive safe integer that grows by one per command. */
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

/** `stage:goGenerator`; null goes to black. */
export type VjGoGeneratorPayload = {
  generatorId: VjGeneratorId | null;
  variant?: string | null;
} & VjClientCommandFields;

/** `stage:setTransition`, a partial patch. */
export type VjSetTransitionPayload = {
  mode?: VjTransitionId;
  length?: VjTransitionLength;
} & VjClientCommandFields;

/** `stage:setOverlay`, a partial patch. */
export type VjSetOverlayPayload = {
  text?: string;
  style?: VjOverlayStyle;
  isVisible?: boolean;
  position?: VjOverlayPosition;
  size?: VjOverlaySize;
  colorToken?: VjColorToken;
  /** 1000..600000 sets hideAt from when the overlay shows; null turns auto-hide off. */
  hideAfterMs?: number | null;
} & VjClientCommandFields;

/** One effect's patch; absent fields keep the current value (or the catalog default). */
export type VjEffectSettingPatch = Partial<VjEffectSetting>;

/** `stage:setEffects`, a partial patch. */
export type VjSetEffectsPayload = {
  speed?: VjSpeed;
  isBlackout?: boolean;
  /** null resets that effect to its off default. */
  settings?: Partial<Record<VjEffectId, VjEffectSettingPatch | null>>;
  isImmediate?: boolean;
} & VjClientCommandFields;

/** `stage:setStrobe`. */
export type VjSetStrobePayload = {
  isStrobing: boolean;
  isImmediate?: boolean;
} & VjClientCommandFields;

/** `stage:setShuffle`, a partial patch. */
export type VjSetShufflePayload = {
  isOn?: boolean;
  intervalKind?: VjShuffleIntervalKind;
  intervalValue?: number;
  source?: VjShuffleSource;
  /** Replaces the whole list. */
  excludedClipIds?: string[];
} & VjClientCommandFields;

/** `stage:setTempo`, a partial patch. */
export type VjSetTempoPayload = {
  bpm?: number;
  downbeatAt?: number;
  quantize?: VjQuantize;
  source?: VjTempoSource;
} & VjClientCommandFields;

/** `stage:setMix`, a partial patch. */
export type VjSetMixPayload = {
  clipId?: string | null;
  amount?: number;
  blendMode?: VjBlendMode;
} & VjClientCommandFields;

/** `stage:swapMix`. */
export type VjSwapMixPayload = VjClientCommandFields;

/** `stage:setScreenOverride`; a null override removes the entry. */
export type VjSetScreenOverridePayload = {
  screenId: string;
  override: VjScreenOverride | null;
} & VjClientCommandFields;

/** `stage:resetLook`. */
export type VjResetLookPayload = {
  isImmediate?: boolean;
} & VjClientCommandFields;

/** `stage:recallScene`. */
export type VjRecallScenePayload = { sceneId: string } & VjClientCommandFields;

/** `stage:setlistSelect`: index null arms the set list without recalling; a number recalls that item. */
export type VjSetlistSelectPayload = {
  setlistId: string | null;
  index: number | null;
} & VjClientCommandFields;

/** `stage:setlistNext` and `stage:setlistPrevious`. */
export type VjSetlistStepPayload = VjClientCommandFields;

/** `stage:setCountdown`, a partial patch. */
export type VjSetCountdownPayload = {
  isVisible?: boolean;
  /** Absolute server epoch ms; or send durationMs. */
  targetAt?: number;
  durationMs?: number;
  label?: string;
} & VjClientCommandFields;

/** `stage:setLogo`, a partial patch. */
export type VjSetLogoPayload = {
  isVisible?: boolean;
  corner?: VjLogoCorner;
} & VjClientCommandFields;

/** `stage:setEventCard`, a partial patch. */
export type VjSetEventCardPayload = {
  isVisible?: boolean;
  kind?: VjEventCardKind;
} & VjClientCommandFields;

/** Unstamped remote frame. screenId null identifies every connected screen. */
export interface VjScreenIdentifyPayload {
  screenId: string | null;
}

/** `clock:sync` carries nothing. */
export type VjClockSyncPayload = Record<string, never>;

/** `screen:advance`: the lead's shuffle report. */
export interface VjScreenAdvancePayload {
  expectedClipSequence: number;
  clipId: string;
}

/** `screen:status`: a screen's fullscreen flag, preload report, and the
 *  optional health, next pick and mic report. */
export interface VjScreenStatusPayload {
  isFullscreen: boolean;
  preload: VjScreenPreload;
  health?: VjScreenHealth;
  nextClipId?: string | null;
  mic?: VjScreenMicReport | null;
}

/** The ack of `session:reauth`: the new `exp` in epoch seconds, or a
 *  transport code; both carry the server's clock. */
export type VjReauthAck =
  | { ok: true; exp: number; serverNow: number }
  | { ok: false; code: VjWsTransportCode; serverNow: number };

/** `screen:role`: sent to one screen on attach and on every lead change. */
export interface VjScreenRoleFrame {
  isLead: boolean;
}

/** `screens:update`: every screen of the stage, sorted by `number`. */
export interface VjScreensUpdateFrame {
  screens: VjScreenStatus[];
}

/** `screen:identify` to one screen: draw this number for `durationMs`. */
export interface VjScreenIdentifyFrame {
  /** The screen's number ("Screen 2"). */
  number: number;
  /** How long the screen shows it: VJ_LIMITS.identifyDurationMs. */
  durationMs: number;
}

/** Every frame a client may send on `/vj`. */
export const VJ_CLIENT_FRAME_NAMES = [
  'vj:attach',
  'clock:sync',
  'session:reauth',
  'stage:setPack',
  'stage:goClip',
  'stage:goGenerator',
  'stage:setTransition',
  'stage:setOverlay',
  'stage:setEffects',
  'stage:setStrobe',
  'stage:setShuffle',
  'stage:setTempo',
  'stage:setMix',
  'stage:swapMix',
  'stage:setScreenOverride',
  'stage:resetLook',
  'stage:recallScene',
  'stage:setlistSelect',
  'stage:setlistNext',
  'stage:setlistPrevious',
  'stage:setCountdown',
  'stage:setLogo',
  'stage:setEventCard',
  'screen:identify',
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
  'screen:identify',
  'exception',
] as const;
export type VjServerFrameName = (typeof VJ_SERVER_FRAME_NAMES)[number];

/** Every frame that carries clientId and commandSequence. */
export const VJ_REMOTE_COMMAND_NAMES = [
  'stage:setPack',
  'stage:goClip',
  'stage:goGenerator',
  'stage:setTransition',
  'stage:setOverlay',
  'stage:setEffects',
  'stage:setStrobe',
  'stage:setShuffle',
  'stage:setTempo',
  'stage:setMix',
  'stage:swapMix',
  'stage:setScreenOverride',
  'stage:resetLook',
  'stage:recallScene',
  'stage:setlistSelect',
  'stage:setlistNext',
  'stage:setlistPrevious',
  'stage:setCountdown',
  'stage:setLogo',
  'stage:setEventCard',
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
