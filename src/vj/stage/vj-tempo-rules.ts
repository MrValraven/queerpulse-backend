import {
  VJ_BEATS_PER_BAR,
  VJ_LIMITS,
  VJ_QUANTIZE_MODES,
  VJ_TEMPO_SOURCES,
  vjBeatMs,
  vjBeatPositionAt,
  vjLastDownbeatAt,
  type VjScreenMicReport,
  type VjSocketErrorCode,
  type VjStageState,
  type VjTempo,
} from '../vj.contract';
import {
  acceptRule,
  hasAnyField,
  isFiniteInRange,
  isOneOf,
  isRecord,
  isSafeIntegerInRange,
  readVjImmediateFlag,
  refuseRule,
  roundToTenth,
  type VjRuleFunction,
} from './vj-rule-kit';

/** The fields a `stage:setTempo` patch may carry. */
const VJ_TEMPO_PATCH_FIELDS = [
  'bpm',
  'downbeatAt',
  'quantize',
  'source',
] as const;

/** Contract 7.6 `stage:setTempo` steps 1 to 5; the first failing step's code, or null. */
function checkVjTempoPatch(
  payload: Record<string, unknown>,
  now: number,
  isLeadMicOn: boolean,
): VjSocketErrorCode | null {
  const { bpm, downbeatAt, quantize, source } = payload;
  if (
    bpm !== undefined &&
    !isFiniteInRange(bpm, VJ_LIMITS.bpmMin, VJ_LIMITS.bpmMax)
  ) {
    return 'vj_bpm_out_of_range';
  }
  if (
    downbeatAt !== undefined &&
    !isSafeIntegerInRange(
      downbeatAt,
      now - VJ_LIMITS.downbeatSkewMsMax,
      now + VJ_LIMITS.downbeatSkewMsMax,
    )
  ) {
    return 'vj_downbeat_out_of_range';
  }
  if (quantize !== undefined && !isOneOf(VJ_QUANTIZE_MODES, quantize)) {
    return 'vj_quantize_invalid';
  }
  if (source !== undefined && !isOneOf(VJ_TEMPO_SOURCES, source)) {
    return 'vj_tempo_source_invalid';
  }
  if (source === 'mic' && (bpm !== undefined || downbeatAt !== undefined)) {
    return 'vj_tempo_source_conflict';
  }
  if (source === 'mic' && !isLeadMicOn) {
    return 'vj_mic_unavailable';
  }
  return null;
}

/** The tempo a checked patch leaves: a bpm alone re-anchors the downbeat on
 *  the last "1" of the current grid, and a bpm or downbeat without a source
 *  sets the source to manual. */
function patchedVjTempo(
  current: VjTempo,
  payload: Record<string, unknown>,
  now: number,
): VjTempo {
  const bpm = typeof payload.bpm === 'number' ? payload.bpm : null;
  const downbeatAt =
    typeof payload.downbeatAt === 'number' ? payload.downbeatAt : null;
  const quantize = isOneOf(VJ_QUANTIZE_MODES, payload.quantize)
    ? payload.quantize
    : current.quantize;
  const isGridMoved = bpm !== null || downbeatAt !== null;
  let source = current.source;
  if (isOneOf(VJ_TEMPO_SOURCES, payload.source)) {
    source = payload.source;
  } else if (isGridMoved) {
    source = 'manual';
  }
  let nextDownbeatAt = current.downbeatAt;
  if (downbeatAt !== null) {
    nextDownbeatAt = downbeatAt;
  } else if (bpm !== null) {
    nextDownbeatAt = vjLastDownbeatAt(current, now);
  }
  return {
    bpm: bpm === null ? current.bpm : roundToTenth(bpm),
    downbeatAt: nextDownbeatAt,
    quantize,
    source,
  };
}

/** `stage:setTempo` (contract 7.6): the field rules in order, `isImmediate`
 *  last, then the patched tempo. A patch with none of the four fields
 *  answers vj_patch_empty. */
export const ruleSetTempo: VjRuleFunction = (state, payload, context) => {
  if (!hasAnyField(payload, VJ_TEMPO_PATCH_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const fieldCode = checkVjTempoPatch(
    payload,
    context.now,
    context.isLeadMicOn,
  );
  if (fieldCode !== null) {
    return refuseRule(fieldCode);
  }
  const immediateFlag = readVjImmediateFlag('stage:setTempo', payload);
  if (immediateFlag.code !== null) {
    return refuseRule(immediateFlag.code);
  }
  const nextState: VjStageState = {
    ...state,
    tempo: patchedVjTempo(state.tempo, payload, context.now),
  };
  return acceptRule(nextState, { isImmediate: immediateFlag.isImmediate });
};

/** How far `serverTime` lies from the nearest beat of the tempo grid, in ms. */
function vjDistanceToNearestBeatMs(tempo: VjTempo, serverTime: number): number {
  const phaseMs =
    vjBeatPositionAt(tempo, serverTime).phase * vjBeatMs(tempo.bpm);
  return Math.min(phaseMs, vjBeatMs(tempo.bpm) - phaseMs);
}

/** Contract 7.9 adoption of the lead screen's mic tempo; null when any
 *  condition fails (a source other than mic, a missing bpm or beat, confidence under 0.6,
 *  under 2000 ms since the last adoption, or a change under 0.5 BPM and
 *  40 ms of phase). The adopted grid keeps the bar position of `beatAt`. */
export function adoptVjMicTempo(
  tempo: VjTempo,
  mic: VjScreenMicReport,
  lastAdoptedAt: number | null,
  now: number,
): VjTempo | null {
  if (tempo.source !== 'mic' || mic.bpm === null || mic.beatAt === null) {
    return null;
  }
  if (mic.confidence < VJ_LIMITS.micConfidenceMin) {
    return null;
  }
  if (
    lastAdoptedAt !== null &&
    now - lastAdoptedAt < VJ_LIMITS.micTempoMinIntervalMs
  ) {
    return null;
  }
  const isBpmMoved = Math.abs(mic.bpm - tempo.bpm) >= VJ_LIMITS.micBpmDeltaMin;
  const isPhaseMoved =
    vjDistanceToNearestBeatMs(tempo, mic.beatAt) >=
    VJ_LIMITS.micPhaseDriftMsMin;
  if (!isBpmMoved && !isPhaseMoved) {
    return null;
  }
  const position = vjBeatPositionAt(tempo, mic.beatAt);
  const beatInBar =
    (position.beatInBar + (position.phase >= 0.5 ? 1 : 0)) % VJ_BEATS_PER_BAR;
  const bpm = roundToTenth(mic.bpm);
  return {
    bpm,
    downbeatAt: Math.round(mic.beatAt - beatInBar * vjBeatMs(bpm)),
    quantize: tempo.quantize,
    source: 'mic',
  };
}

/** A restored tempo (contract 7.13, plan note 13): `downbeatAt` kept when it
 *  is a safe integer, with no skew rule, so its phase carries over; `bpm`
 *  (rounded to one decimal), `quantize` and `source` each take the default
 *  when invalid. */
export function restoredVjTempo(value: unknown, defaults: VjTempo): VjTempo {
  if (!isRecord(value)) {
    return { ...defaults };
  }
  return {
    bpm: isFiniteInRange(value.bpm, VJ_LIMITS.bpmMin, VJ_LIMITS.bpmMax)
      ? roundToTenth(value.bpm)
      : defaults.bpm,
    downbeatAt: isSafeIntegerInRange(
      value.downbeatAt,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    )
      ? value.downbeatAt
      : defaults.downbeatAt,
    quantize: isOneOf(VJ_QUANTIZE_MODES, value.quantize)
      ? value.quantize
      : defaults.quantize,
    source: isOneOf(VJ_TEMPO_SOURCES, value.source)
      ? value.source
      : defaults.source,
  };
}
