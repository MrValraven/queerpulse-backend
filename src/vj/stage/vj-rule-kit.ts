import { isUUID } from 'class-validator';
import { vjAckFailure } from '../vj.constants';
import {
  VJ_LIMITS,
  type VjAckFailure,
  type VjGeneratorId,
  type VjRemoteCommandName,
  type VjSceneLook,
  type VjSocketErrorCode,
  type VjStageState,
} from '../vj.contract';

/** One read a remote command needs before its rules can finish (contract 7.7).
 *  The gateway resolves every lookup in parallel and hands the answers back. */
export type VjCommandLookup =
  | { kind: 'pack'; packId: string }
  | { kind: 'clip'; clipId: string }
  | { kind: 'clipsInPack'; packId: string; clipIds: string[] }
  | { kind: 'packClip'; packId: string; clipId: string }
  | { kind: 'scene'; sceneId: string }
  | { kind: 'setlistItem'; setlistId: string; index: number | null };

/** A set list read for a recall or a step: the item at `index` (its scene and
 *  look, null when the index holds none) and how many items the list has. */
export interface VjSetlistItemRead {
  setlistId: string;
  index: number | null;
  itemCount: number;
  sceneId: string | null;
  look: VjSceneLook | null;
}

/** The answers to a command's lookups, read by the apply step's rules. */
export interface VjLookupResults {
  /** 'pack' answers by lowercased pack id; null when no pack has it. */
  packs: ReadonlyMap<string, { eventId: string | null } | null>;
  /** Ids of 'clip' lookups that exist. */
  existingClipIds: ReadonlySet<string>;
  /** Ids of 'clipsInPack' lookups that sit in the pack. */
  clipIdsInPack: ReadonlySet<string>;
  /** 'packClip' answers keyed by vjPackClipKey. */
  packClips: ReadonlyMap<string, { isFavorite: boolean } | null>;
  /** 'scene' answers; null when no scene has the id. */
  scenes: ReadonlyMap<string, VjSceneLook | null>;
  /** 'setlistItem' answers keyed by vjSetlistItemKey; null when the set list is gone. */
  setlistItems: ReadonlyMap<string, VjSetlistItemRead | null>;
}

/** The answers of a command that listed no lookups. */
export const EMPTY_VJ_LOOKUP_RESULTS: VjLookupResults = Object.freeze({
  packs: new Map<string, { eventId: string | null } | null>(),
  existingClipIds: new Set<string>(),
  clipIdsInPack: new Set<string>(),
  packClips: new Map<string, { isFavorite: boolean } | null>(),
  scenes: new Map<string, VjSceneLook | null>(),
  setlistItems: new Map<string, VjSetlistItemRead | null>(),
});

/** The `packClips` key of one pack and clip pair, both lowercased. */
export function vjPackClipKey(packId: string, clipId: string): string {
  return `${packId.toLowerCase()}:${clipId.toLowerCase()}`;
}

/** The `setlistItems` key of one set list and index; a null index reads the
 *  list's item count only. */
export function vjSetlistItemKey(
  setlistId: string,
  index: number | null,
): string {
  return `${setlistId.toLowerCase()}:${index === null ? 'null' : String(index)}`;
}

/** What every rule reads besides the state and the payload. */
export interface VjRuleContext {
  now: number;
  /** Null in the prepare step: a rule lists its lookups and skips the checks that need them. */
  lookups: VjLookupResults | null;
  connectedScreenIds: ReadonlySet<string>;
  /** The lead screen's last status carries a mic report. */
  isLeadMicOn: boolean;
}

/** An accepted command: the next state and what contract 7.4 needs to land it. */
export interface VjAcceptedChange {
  nextState: VjStageState;
  lookups: VjCommandLookup[];
  isImmediate: boolean;
  /** Recall and set list steps (contract 7.4 step 2). */
  isLookSwitch: boolean;
  /** undefined keeps overlay.hideAt; null clears it; a number stamps stampAt + value. */
  overlayHideAfterMs: number | null | undefined;
}

/** What a remote command's rules answer: a refusal or an accepted change. */
export type VjCommandRuleResult =
  | { failure: VjAckFailure; accepted: null }
  | { failure: null; accepted: VjAcceptedChange };

/** One command's rules: pure, from the state, the payload and the context. */
export type VjRuleFunction = (
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
) => VjCommandRuleResult;

/** A refusal with its code, and the current state for the codes that carry it. */
export function refuseRule(
  code: VjSocketErrorCode,
  state?: VjStageState,
): VjCommandRuleResult {
  return { failure: vjAckFailure(code, state), accepted: null };
}

/** An accepted change; options left out default to an empty lookup list,
 *  isImmediate false, isLookSwitch false and the overlay hide time kept. */
export function acceptRule(
  nextState: VjStageState,
  options: Partial<Omit<VjAcceptedChange, 'nextState'>> = {},
): VjCommandRuleResult {
  return {
    failure: null,
    accepted: {
      nextState,
      lookups: options.lookups ?? [],
      isImmediate: options.isImmediate ?? false,
      isLookSwitch: options.isLookSwitch ?? false,
      overlayHideAfterMs: options.overlayHideAfterMs,
    },
  };
}

/** A plain object (arrays and null excluded). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text in the shape of a uuid (the same check the REST input rules run). */
export function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

/** A uuid lowercased or null, with `isValid` false for anything else. */
export function readNullableUuid(
  value: unknown,
): { isValid: true; id: string | null } | { isValid: false; id: null } {
  if (value === null) {
    return { isValid: true, id: null };
  }
  if (isUuidString(value)) {
    return { isValid: true, id: value.toLowerCase() };
  }
  return { isValid: false, id: null };
}

/** Whether a value is one of the list's members. */
export function isOneOf<Value>(
  list: readonly Value[],
  value: unknown,
): value is Value {
  return (list as readonly unknown[]).includes(value);
}

/** Whether the payload carries at least one of the fields (undefined counts as absent). */
export function hasAnyField(
  payload: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => payload[field] !== undefined);
}

/** Whether the object's own keys are exactly the listed ones, in any order. */
export function hasExactlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const ownKeys = Object.keys(value);
  const expectedKeys = new Set(keys);
  return (
    ownKeys.length === expectedKeys.size &&
    ownKeys.every((key) => expectedKeys.has(key))
  );
}

/** U+0000..U+001F, U+007F..U+009F, U+2028 and U+2029 (v1 contract 6.6). */
export function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

/** A safe integer from minimum to maximum, both included. */
export function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

/** A finite number from minimum to maximum, both included. */
export function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

/** Rounds to one decimal place (a tempo's bpm). */
export function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** What goes live: a clip, a generator, or black. */
export type VjLiveSource =
  | { kind: 'clip'; clipId: string }
  | {
      kind: 'generator';
      generatorId: VjGeneratorId;
      generatorVariant: string | null;
    }
  | null;

/** The history with the clip first, each id once, at most VJ_LIMITS.recentClipsMax. */
export function withVjRecentClip(
  recentClipIds: readonly string[],
  clipId: string,
): string[] {
  return [
    clipId,
    ...recentClipIds.filter((recentClipId) => recentClipId !== clipId),
  ].slice(0, VJ_LIMITS.recentClipsMax);
}

/** Sets the live source, clears the other one, clipSequence + 1, a clip to the front of recentClipIds (once, at most 8). liveSince is stamped later (contract 7.4 step 5). */
export function withVjLiveSource(
  state: VjStageState,
  source: VjLiveSource,
): VjStageState {
  const clipSequence = state.clipSequence + 1;
  if (source === null) {
    return {
      ...state,
      liveClipId: null,
      liveGeneratorId: null,
      liveGeneratorVariant: null,
      clipSequence,
    };
  }
  if (source.kind === 'clip') {
    return {
      ...state,
      liveClipId: source.clipId,
      liveGeneratorId: null,
      liveGeneratorVariant: null,
      recentClipIds: withVjRecentClip(state.recentClipIds, source.clipId),
      clipSequence,
    };
  }
  return {
    ...state,
    liveClipId: null,
    liveGeneratorId: source.generatorId,
    liveGeneratorVariant: source.generatorVariant,
    clipSequence,
  };
}

/** The `stage:setEffects` patch fields other than `isBlackout`. */
const VJ_SET_EFFECTS_OTHER_FIELDS = ['speed', 'settings'] as const;

/** Whether `isImmediate: true` is allowed for this command and payload. */
function isImmediateAllowed(
  name: VjRemoteCommandName,
  payload: Record<string, unknown>,
): boolean {
  if (name === 'stage:setEffects') {
    return (
      payload.isBlackout !== undefined &&
      !hasAnyField(payload, VJ_SET_EFFECTS_OTHER_FIELDS)
    );
  }
  if (name === 'stage:setStrobe') {
    return payload.isStrobing === false;
  }
  return name === 'stage:resetLook';
}

/** Contract 7.4 last paragraph: a non-boolean answers vj_effect_flag_invalid; true outside the three commands answers vj_immediate_not_allowed. */
export function readVjImmediateFlag(
  name: VjRemoteCommandName,
  payload: Record<string, unknown>,
):
  | { code: VjSocketErrorCode; isImmediate: false }
  | { code: null; isImmediate: boolean } {
  const flag = payload.isImmediate;
  if (flag === undefined) {
    return { code: null, isImmediate: false };
  }
  if (typeof flag !== 'boolean') {
    return { code: 'vj_effect_flag_invalid', isImmediate: false };
  }
  if (flag && !isImmediateAllowed(name, payload)) {
    return { code: 'vj_immediate_not_allowed', isImmediate: false };
  }
  return { code: null, isImmediate: flag };
}
