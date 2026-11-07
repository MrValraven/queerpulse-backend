import {
  VJ_CLIP_READY_STATES,
  VJ_LIMITS,
  VJ_PRELOAD_FAILURES,
  VJ_RENDERERS,
  type VjClipReadyState,
  type VjPreloadFailure,
  type VjRenderer,
  type VjScreenClipStatus,
  type VjScreenHealth,
  type VjScreenMicReport,
  type VjScreenPreload,
  type VjScreenStatus,
} from '../vj.contract';
import {
  isFiniteInRange,
  isOneOf,
  isRecord,
  isSafeIntegerInRange,
  isUuidString,
  readNullableUuid,
  roundToTenth,
} from './vj-rule-kit';

/** Most clip entries kept from one `screen:status` report (v1 contract 6.6). */
const SCREEN_STATUS_CLIPS_MAX = 200;

/** Highest `health.fps` a screen may report (contract 3.8). */
const HEALTH_FPS_MAX = 240;

/** Highest `health.droppedFrames` a screen may report (contract 3.8). */
const HEALTH_DROPPED_FRAMES_MAX = 1_000_000;

/** How far `mic.beatAt` may sit from the server's clock (contract 7.9). */
const MIC_BEAT_SKEW_MAX_MS = 5000;

/** One screen of a stage, keyed by its `screenId`. */
export interface VjScreenEntry {
  screenId: string;
  number: number;
  /** The socket attached now; null while the screen is offline. */
  socketId: string | null;
  isFullscreen: boolean;
  connectedAt: number | null;
  /** Grows with every attach in the stage; breaks a `connectedAt` tie. */
  connectionOrder: number;
  disconnectedAt: number | null;
  lastSeenAt: number;
  preload: VjScreenPreload;
  /** Null until the screen reports valid health. */
  health: VjScreenHealth | null;
  /** The lead's shuffle pick; always null on a follower. */
  nextClipId: string | null;
  /** Null while the screen reports no valid mic. */
  mic: VjScreenMicReport | null;
}

/** A `screen:status` frame read into the fields a screen entry stores. */
export interface VjParsedScreenStatus {
  isFullscreen: boolean;
  preload: VjScreenPreload;
  health: VjScreenHealth | null;
  nextClipId: string | null;
  mic: VjScreenMicReport | null;
}

/** Rounds to two decimal places (a mic level). */
function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One preload clip entry, or null when any part is malformed (v1 rule). */
function parseClipStatus(value: unknown): VjScreenClipStatus | null {
  if (!isRecord(value) || !isUuidString(value.clipId)) {
    return null;
  }
  if (!isOneOf<VjClipReadyState>(VJ_CLIP_READY_STATES, value.state)) {
    return null;
  }
  if (!isFiniteInRange(value.progress, 0, 1)) {
    return null;
  }
  const rawFailure = value.failure ?? null;
  let failure: VjPreloadFailure | null = null;
  if (rawFailure !== null) {
    if (!isOneOf<VjPreloadFailure>(VJ_PRELOAD_FAILURES, rawFailure)) {
      return null;
    }
    failure = rawFailure;
  }
  return {
    clipId: value.clipId.toLowerCase(),
    state: value.state,
    progress: value.progress,
    failure: value.state === 'failed' ? failure : null,
  };
}

/** A fresh copy of the preload report, the clip list cut to 200 entries, or
 *  null when any part is malformed. */
function parsePreload(value: unknown): VjScreenPreload | null {
  if (!isRecord(value)) {
    return null;
  }
  const packRead = readNullableUuid(value.packId);
  const { clips } = value;
  if (!packRead.isValid || !Array.isArray(clips)) {
    return null;
  }
  const parsedClips: VjScreenClipStatus[] = [];
  for (const clip of clips.slice(0, SCREEN_STATUS_CLIPS_MAX)) {
    const parsedClip = parseClipStatus(clip);
    if (parsedClip === null) {
      return null;
    }
    parsedClips.push(parsedClip);
  }
  return { packId: packRead.id, clips: parsedClips };
}

/** The health report, fps rounded to one decimal, or null when absent or any
 *  field is invalid (contract 7.9). */
function parseHealth(value: unknown): VjScreenHealth | null {
  if (!isRecord(value)) {
    return null;
  }
  const { renderer, fps, droppedFrames, cacheBytes, isEffectLoadHigh } = value;
  if (
    !isOneOf<VjRenderer>(VJ_RENDERERS, renderer) ||
    !isFiniteInRange(fps, 0, HEALTH_FPS_MAX) ||
    !isSafeIntegerInRange(droppedFrames, 0, HEALTH_DROPPED_FRAMES_MAX) ||
    !isSafeIntegerInRange(cacheBytes, 0, Number.MAX_SAFE_INTEGER) ||
    typeof isEffectLoadHigh !== 'boolean'
  ) {
    return null;
  }
  return {
    renderer,
    fps: roundToTenth(fps),
    droppedFrames,
    cacheBytes,
    isEffectLoadHigh,
  };
}

/** The mic report, level rounded to two decimals, or null when absent or any
 *  field is invalid (contract 7.9). */
function parseMic(value: unknown, now: number): VjScreenMicReport | null {
  if (!isRecord(value)) {
    return null;
  }
  const { level, bpm, confidence, beatAt } = value;
  const isBpmValid =
    bpm === null || isFiniteInRange(bpm, VJ_LIMITS.bpmMin, VJ_LIMITS.bpmMax);
  const isBeatAtValid =
    beatAt === null ||
    isSafeIntegerInRange(
      beatAt,
      now - MIC_BEAT_SKEW_MAX_MS,
      now + MIC_BEAT_SKEW_MAX_MS,
    );
  if (
    !isFiniteInRange(level, 0, 1) ||
    !isBpmValid ||
    !isFiniteInRange(confidence, 0, 1) ||
    !isBeatAtValid
  ) {
    return null;
  }
  return {
    level: roundToHundredth(level),
    bpm: bpm,
    confidence,
    beatAt: beatAt,
  };
}

/** Reads a `screen:status` payload (contract 7.9). The fullscreen flag and
 *  preload report follow v1: a malformed pair answers null and the whole
 *  frame is dropped. Health, next clip and mic are each read alone; an
 *  invalid or absent one is stored as null, and a follower's next clip is
 *  always null. */
export function parseVjScreenStatus(
  payload: Record<string, unknown>,
  isLead: boolean,
  now: number,
): VjParsedScreenStatus | null {
  const { isFullscreen } = payload;
  if (typeof isFullscreen !== 'boolean') {
    return null;
  }
  const preload = parsePreload(payload.preload);
  if (preload === null) {
    return null;
  }
  const nextClipRead = readNullableUuid(payload.nextClipId);
  return {
    isFullscreen,
    preload,
    health: parseHealth(payload.health),
    nextClipId: isLead ? nextClipRead.id : null,
    mic: parseMic(payload.mic, now),
  };
}

/** One screen entry as the remote lists it; the next clip only on the lead
 *  (note 16), the mic as `{ level, detectedBpm, confidence }`. An offline
 *  screen relays null health and mic, so its meters stop with its socket. */
function toVjScreenStatus(
  entry: VjScreenEntry,
  leadSocketId: string | null,
): VjScreenStatus {
  const isConnected = entry.socketId !== null;
  const isLead = isConnected && entry.socketId === leadSocketId;
  return {
    screenId: entry.screenId,
    number: entry.number,
    isConnected,
    isLead,
    isFullscreen: entry.isFullscreen,
    connectedAt: entry.connectedAt,
    lastSeenAt: entry.lastSeenAt,
    preload: {
      packId: entry.preload.packId,
      clips: entry.preload.clips.map((clip) => ({ ...clip })),
    },
    health: !isConnected || entry.health === null ? null : { ...entry.health },
    nextClipId: isLead ? entry.nextClipId : null,
    mic:
      !isConnected || entry.mic === null
        ? null
        : {
            level: entry.mic.level,
            detectedBpm: entry.mic.bpm,
            confidence: entry.mic.confidence,
          },
  };
}

/** Every entry as `VjScreenStatus`, sorted by screen number. A demoted lead's
 *  stored next clip is dropped (note 16). */
export function toVjScreenStatusList(
  entries: Iterable<VjScreenEntry>,
  leadSocketId: string | null,
): VjScreenStatus[] {
  return Array.from(entries, (entry) =>
    toVjScreenStatus(entry, leadSocketId),
  ).sort((first, second) => first.number - second.number);
}
