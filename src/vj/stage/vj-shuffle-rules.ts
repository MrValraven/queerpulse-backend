import { vjAckFailure } from '../vj.constants';
import {
  VJ_LIMITS,
  VJ_SHUFFLE_BEAT_COUNTS,
  VJ_SHUFFLE_INTERVAL_KINDS,
  VJ_SHUFFLE_SOURCES,
  type VjAckFailure,
  type VjShuffle,
  type VjShuffleIntervalKind,
  type VjShuffleSource,
  type VjSocketErrorCode,
  type VjStageState,
} from '../vj.contract';
import {
  acceptRule,
  hasAnyField,
  isOneOf,
  isRecord,
  isUuidString,
  readVjImmediateFlag,
  refuseRule,
  withVjLiveSource,
  type VjCommandLookup,
  type VjRuleContext,
  type VjRuleFunction,
} from './vj-rule-kit';

/** The `stage:setShuffle` patch fields (contract 7.5). */
const VJ_SET_SHUFFLE_FIELDS = [
  'isOn',
  'intervalKind',
  'intervalValue',
  'source',
  'excludedClipIds',
] as const;

/** Whether a value is a valid interval for its kind: seconds an integer
 *  2..60, beats one of 4, 8, 16, 32. */
function isVjShuffleIntervalValid(
  kind: VjShuffleIntervalKind,
  value: unknown,
): value is number {
  if (typeof value !== 'number') {
    return false;
  }
  if (kind === 'beats') {
    return isOneOf(VJ_SHUFFLE_BEAT_COUNTS, value);
  }
  return (
    Number.isInteger(value) &&
    value >= VJ_LIMITS.shuffleSecondsMin &&
    value <= VJ_LIMITS.shuffleSecondsMax
  );
}

/** The interval a kind falls back to (8 for either kind). */
function defaultVjShuffleIntervalValue(kind: VjShuffleIntervalKind): number {
  return kind === 'beats'
    ? VJ_LIMITS.shuffleBeatsDefault
    : VJ_LIMITS.shuffleSecondsDefault;
}

/** Ids lowercased, each once, sorted ascending (the canonical form of
 *  contract 3.6). */
function canonicalVjClipIdList(clipIds: readonly string[]): string[] {
  return Array.from(
    new Set(clipIds.map((clipId) => clipId.toLowerCase())),
  ).sort();
}

/** The `excludedClipIds` field read: an array of uuid strings, at most 200,
 *  answered canonical; null for anything else. */
function readVjExcludedClipIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > VJ_LIMITS.excludedClipIdsMax ||
    !value.every((clipId) => isUuidString(clipId))
  ) {
    return null;
  }
  return canonicalVjClipIdList(value);
}

/** The v1 `isOn`, `intervalKind` and `intervalValue` rules over the current
 *  shuffle: a kind change with no value keeps the value when it fits the new
 *  kind, else takes 8. */
function shuffleTimingPatch(
  shuffle: VjShuffle,
  payload: Record<string, unknown>,
):
  | { code: VjSocketErrorCode; shuffle: null }
  | { code: null; shuffle: VjShuffle } {
  const next: VjShuffle = { ...shuffle };
  if (payload.isOn !== undefined) {
    if (typeof payload.isOn !== 'boolean') {
      return { code: 'vj_effect_flag_invalid', shuffle: null };
    }
    next.isOn = payload.isOn;
  }
  if (payload.intervalKind !== undefined) {
    if (!isOneOf(VJ_SHUFFLE_INTERVAL_KINDS, payload.intervalKind)) {
      return { code: 'vj_shuffle_interval_invalid', shuffle: null };
    }
    next.intervalKind = payload.intervalKind;
  }
  const intervalValue: unknown =
    payload.intervalValue !== undefined
      ? payload.intervalValue
      : isVjShuffleIntervalValid(next.intervalKind, next.intervalValue)
        ? next.intervalValue
        : defaultVjShuffleIntervalValue(next.intervalKind);
  if (!isVjShuffleIntervalValid(next.intervalKind, intervalValue)) {
    return { code: 'vj_shuffle_interval_invalid', shuffle: null };
  }
  next.intervalValue = intervalValue;
  return { code: null, shuffle: next };
}

/** `stage:setShuffle` (contract 7.5): the v1 timing rules, `source`,
 *  `excludedClipIds` (canonical, at most 200, an active pack needed when
 *  non-empty), `isImmediate` last, then the `clipsInPack` answer. */
export const ruleSetShuffle: VjRuleFunction = (
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
) => {
  if (!hasAnyField(payload, VJ_SET_SHUFFLE_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const timing = shuffleTimingPatch(state.shuffle, payload);
  if (timing.code !== null) {
    return refuseRule(timing.code);
  }
  const shuffle = timing.shuffle;
  if (payload.source !== undefined) {
    if (!isOneOf<VjShuffleSource>(VJ_SHUFFLE_SOURCES, payload.source)) {
      return refuseRule('vj_shuffle_source_invalid');
    }
    shuffle.source = payload.source;
  }
  if (payload.excludedClipIds !== undefined) {
    const excludedClipIds = readVjExcludedClipIds(payload.excludedClipIds);
    if (excludedClipIds === null) {
      return refuseRule('vj_excluded_clips_invalid');
    }
    if (excludedClipIds.length > 0 && state.activePackId === null) {
      return refuseRule('vj_no_active_pack');
    }
    shuffle.excludedClipIds = excludedClipIds;
  }
  const immediate = readVjImmediateFlag('stage:setShuffle', payload);
  if (immediate.code !== null) {
    return refuseRule(immediate.code);
  }
  const activePackId = state.activePackId;
  if (
    payload.excludedClipIds === undefined ||
    shuffle.excludedClipIds.length === 0 ||
    activePackId === null
  ) {
    return acceptRule({ ...state, shuffle });
  }
  const lookups: VjCommandLookup[] = [
    {
      kind: 'clipsInPack',
      packId: activePackId,
      clipIds: shuffle.excludedClipIds,
    },
  ];
  const lookupResults = context.lookups;
  if (
    lookupResults !== null &&
    !shuffle.excludedClipIds.every((clipId) =>
      lookupResults.clipIdsInPack.has(clipId),
    )
  ) {
    return refuseRule('vj_clip_not_in_pack');
  }
  return acceptRule({ ...state, shuffle }, { lookups });
};

/** What the `screen:advance` checks answer: a refusal, or the pack and clip
 *  the `packClip` lookup reads. */
export type VjAdvanceCheck =
  | { failure: VjAckFailure; lookups: [] }
  | {
      failure: null;
      packId: string;
      clipId: string;
      lookups: VjCommandLookup[];
    };

/** An advance refusal, with the state for the codes that carry it. */
function refuseVjAdvance(
  code: VjSocketErrorCode,
  state?: VjStageState,
): VjAdvanceCheck {
  return { failure: vjAckFailure(code, state), lookups: [] };
}

/** v1 order (vj_not_lead, vj_shuffle_off, vj_no_active_pack, vj_stale_clip_sequence, malformed clip id vj_clip_not_in_pack), then vj_clip_excluded; lists the packClip lookup. */
export function checkVjAdvance(
  state: VjStageState,
  isLead: boolean,
  payload: Record<string, unknown>,
): VjAdvanceCheck {
  if (!isLead) {
    return refuseVjAdvance('vj_not_lead', state);
  }
  if (!state.shuffle.isOn) {
    return refuseVjAdvance('vj_shuffle_off', state);
  }
  if (state.activePackId === null) {
    return refuseVjAdvance('vj_no_active_pack', state);
  }
  const { expectedClipSequence, clipId } = payload;
  if (
    typeof expectedClipSequence !== 'number' ||
    !Number.isSafeInteger(expectedClipSequence) ||
    expectedClipSequence !== state.clipSequence
  ) {
    return refuseVjAdvance('vj_stale_clip_sequence', state);
  }
  if (!isUuidString(clipId)) {
    return refuseVjAdvance('vj_clip_not_in_pack');
  }
  const lowercaseClipId = clipId.toLowerCase();
  if (state.shuffle.excludedClipIds.includes(lowercaseClipId)) {
    return refuseVjAdvance('vj_clip_excluded', state);
  }
  const packId = state.activePackId;
  return {
    failure: null,
    packId,
    clipId: lowercaseClipId,
    lookups: [{ kind: 'packClip', packId, clipId: lowercaseClipId }],
  };
}

/** With the packClip answer: vj_clip_not_in_pack, then vj_clip_not_favorite when source is favorites; else the next state through withVjLiveSource. */
export function applyVjAdvance(
  state: VjStageState,
  check: Extract<VjAdvanceCheck, { failure: null }>,
  packClip: { isFavorite: boolean } | null,
):
  | { failure: VjAckFailure; nextState: null }
  | { failure: null; nextState: VjStageState } {
  if (packClip === null) {
    return { failure: vjAckFailure('vj_clip_not_in_pack'), nextState: null };
  }
  if (state.shuffle.source === 'favorites' && !packClip.isFavorite) {
    return {
      failure: vjAckFailure('vj_clip_not_favorite', state),
      nextState: null,
    };
  }
  return {
    failure: null,
    nextState: withVjLiveSource(state, { kind: 'clip', clipId: check.clipId }),
  };
}

/** Contract 7.13: each shuffle field checked alone (an invalid one takes its
 *  default), excluded ids kept canonical and only for clips still in the
 *  restored pack. */
export function restoredVjShuffle(
  value: unknown,
  defaults: VjShuffle,
  clipIdsInPack: ReadonlySet<string>,
): VjShuffle {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const intervalKind = isOneOf(VJ_SHUFFLE_INTERVAL_KINDS, source.intervalKind)
    ? source.intervalKind
    : defaults.intervalKind;
  const sentExcludedClipIds = Array.isArray(source.excludedClipIds)
    ? source.excludedClipIds.filter((clipId): clipId is string =>
        isUuidString(clipId),
      )
    : [];
  const excludedClipIds = canonicalVjClipIdList(sentExcludedClipIds)
    .filter((clipId) => clipIdsInPack.has(clipId))
    .slice(0, VJ_LIMITS.excludedClipIdsMax);
  return {
    isOn: typeof source.isOn === 'boolean' ? source.isOn : defaults.isOn,
    intervalKind,
    intervalValue: isVjShuffleIntervalValid(intervalKind, source.intervalValue)
      ? source.intervalValue
      : defaultVjShuffleIntervalValue(intervalKind),
    source: isOneOf(VJ_SHUFFLE_SOURCES, source.source)
      ? source.source
      : defaults.source,
    excludedClipIds,
  };
}
