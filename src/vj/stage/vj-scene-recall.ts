/**
 * Scene recall and the set list commands (v2 contract 3.7 recall, 7.5 rows
 * for `stage:recallScene`; sequences contract 5.3 for `stage:setlistSelect`,
 * `stage:setlistNext`, `stage:setlistPrevious`, `stage:setlistSetPlaying` and
 * `stage:setlistSetLooping`). A scene recall is a look switch (v2 contract
 * 7.4 step 2) and writes `overlay.hideAt: null`, so its accepted change
 * carries `isLookSwitch: true` and `overlayHideAfterMs: null`.
 *
 * The set list rules check their fields, list one read at the position the
 * contract's read-position helper names, and hand the read to the pure
 * transition in `vj.contract.ts`; `vjSetlistTransitionChange` then puts the
 * step on screen (a scene through `recallVjScene`, a clip through
 * `withVjLiveSource` only) and passes the transition's clock stamp on.
 *
 * In the prepare step (`context.lookups` null) a rule runs its field rules,
 * lists its lookups and answers the state unchanged; the apply step reruns
 * every check and reads the scene or set list from the lookups.
 */
import {
  VJ_LIMITS,
  vjSetlistLoopingState,
  vjSetlistSelectReadPosition,
  vjSetlistSelectTransition,
  vjSetlistSetPlayingReadPosition,
  vjSetlistSetPlayingTransition,
  vjSetlistStepReadPosition,
  vjSetlistStepTransition,
  type VjEffectSettings,
  type VjRemoteCommandName,
  type VjSceneLook,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjSetlistShow,
  type VjSetlistTransition,
  type VjSetlistTransitionResult,
  type VjSocketErrorCode,
  type VjStageState,
} from '../vj.contract';
import {
  acceptRule,
  isSafeIntegerInRange,
  isUuidString,
  readNullableUuid,
  readVjImmediateFlag,
  refuseRule,
  vjSetlistItemKey,
  withVjLiveSource,
  type VjAcceptedChange,
  type VjCommandLookup,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleFunction,
} from './vj-rule-kit';

/** The options of an accepted change that recalls a look. */
const RECALL_CHANGE_OPTIONS = {
  isLookSwitch: true,
  overlayHideAfterMs: null,
} as const;

/** A copy of each effect setting, so the state never shares an entry with a look. */
function copyVjEffectSettings(settings: VjEffectSettings): VjEffectSettings {
  const copied: VjEffectSettings = {};
  for (const [effectId, setting] of Object.entries(settings)) {
    if (setting !== undefined) {
      copied[effectId as keyof VjEffectSettings] = { ...setting };
    }
  }
  return copied;
}

/** Contract 3.7 recall: a non-null source goes live through withVjLiveSource;
 *  effects speed and settings, transition, overlay (hideAt null) and mix are
 *  replaced whole. Pack, blackout, strobe, tempo, shuffle, countdown, logo,
 *  event card, overrides and the set list stay as they are. */
export function recallVjScene(
  state: VjStageState,
  look: VjSceneLook,
): VjStageState {
  let withSource = state;
  if (look.source !== null) {
    withSource = withVjLiveSource(
      state,
      look.source.kind === 'clip'
        ? { kind: 'clip', clipId: look.source.clipId.toLowerCase() }
        : {
            kind: 'generator',
            generatorId: look.source.generatorId,
            generatorVariant: look.source.generatorVariant,
          },
    );
  }
  return {
    ...withSource,
    effects: {
      ...withSource.effects,
      speed: look.effects.speed,
      settings: copyVjEffectSettings(look.effects.settings),
    },
    transition: {
      mode: look.transition.mode,
      length: {
        unit: look.transition.length.unit,
        value: look.transition.length.value,
      },
    },
    overlay: { ...look.overlay, hideAt: null },
    mix: {
      clipId: look.mix.clipId === null ? null : look.mix.clipId.toLowerCase(),
      amount: look.mix.amount,
      blendMode: look.mix.blendMode,
    },
  };
}

/** `stage:recallScene`: a malformed or unknown id answers vj_scene_not_found. */
export const ruleRecallScene: VjRuleFunction = (state, payload, context) => {
  if (!isUuidString(payload.sceneId)) {
    return refuseRule('vj_scene_not_found');
  }
  const immediate = readVjImmediateFlag('stage:recallScene', payload);
  if (immediate.code !== null) {
    return refuseRule(immediate.code);
  }
  const sceneId = payload.sceneId.toLowerCase();
  const lookups: VjCommandLookup[] = [{ kind: 'scene', sceneId }];
  if (context.lookups === null) {
    return acceptRule(state, { lookups, ...RECALL_CHANGE_OPTIONS });
  }
  const look = context.lookups.scenes.get(sceneId) ?? null;
  if (look === null) {
    return refuseRule('vj_scene_not_found');
  }
  return acceptRule(recallVjScene(state, look), {
    lookups,
    ...RECALL_CHANGE_OPTIONS,
  });
};

/** What putting a step on screen changes: the state and the landing flags. */
export interface VjSetlistShownState {
  nextState: VjStageState;
  isLookSwitch: boolean;
  overlayHideAfterMs: number | null | undefined;
}

/** Puts a transition's step on screen (sequences contract 5.3): a scene goes
 *  through recallVjScene (overlay hideAt cleared); a clip through
 *  withVjLiveSource only (overlay hideAt kept, pack and activePackId as they
 *  are, any pack), like goClip with the pack rule skipped. Both are look
 *  switches; show null changes nothing and lands as no look switch. */
export function showVjSetlistStep(
  state: VjStageState,
  show: VjSetlistShow | null,
): VjSetlistShownState {
  if (show === null) {
    return {
      nextState: state,
      isLookSwitch: false,
      overlayHideAfterMs: undefined,
    };
  }
  if (show.kind === 'scene') {
    return {
      nextState: recallVjScene(state, show.look),
      ...RECALL_CHANGE_OPTIONS,
    };
  }
  return {
    nextState: withVjLiveSource(state, {
      kind: 'clip',
      clipId: show.clipId.toLowerCase(),
    }),
    isLookSwitch: true,
    overlayHideAfterMs: undefined,
  };
}

/** An accepted transition as the change the landing takes: the step shown,
 *  the transition's clock as `setlistClock`, the lookups the command listed.
 *  The server step timer passes the step end it fired for as `scheduledAt`;
 *  every command leaves it null. */
export function vjSetlistTransitionChange(
  transition: VjSetlistTransition,
  lookups: VjCommandLookup[],
  scheduledAt: number | null = null,
): VjAcceptedChange {
  const shown = showVjSetlistStep(transition.nextState, transition.show);
  return {
    nextState: shown.nextState,
    lookups,
    isImmediate: false,
    isLookSwitch: shown.isLookSwitch,
    overlayHideAfterMs: shown.overlayHideAfterMs,
    setlistClock: transition.clock,
    scheduledAt,
  };
}

/** A transition result as a rule result: a code refuses with it; an accepted
 *  transition shows its step and carries its clock. */
function vjSetlistTransitionRule(
  result: VjSetlistTransitionResult,
  lookups: VjCommandLookup[],
): VjCommandRuleResult {
  if (result.code !== null) {
    return refuseRule(result.code);
  }
  return {
    failure: null,
    accepted: vjSetlistTransitionChange(result.transition, lookups),
  };
}

/** An optional boolean field: absent reads as false; anything else but a
 *  boolean answers vj_effect_flag_invalid (sequences contract 5.2). */
function readOptionalVjFlag(
  value: unknown,
): { isValid: true; flag: boolean } | { isValid: false; flag: false } {
  if (value === undefined) {
    return { isValid: true, flag: false };
  }
  if (typeof value !== 'boolean') {
    return { isValid: false, flag: false };
  }
  return { isValid: true, flag: value };
}

/** The `stage:setlistSelect` fields once their shape is checked. */
type VjSetlistSelection =
  | { failure: VjCommandRuleResult }
  | {
      failure: null;
      setlistId: string | null;
      index: number | null;
      isPlaying: boolean;
      isFlashConfirmed: boolean;
    };

/** Field rules of `stage:setlistSelect`, in the frame table's order:
 *  setlistId, index, a null id with an index, the two flags, a null id with
 *  isPlaying true, isImmediate. */
function readVjSetlistSelection(
  payload: Record<string, unknown>,
): VjSetlistSelection {
  const setlist = readNullableUuid(payload.setlistId);
  if (!setlist.isValid) {
    return { failure: refuseRule('vj_setlist_not_found') };
  }
  const index = payload.index;
  // No set list holds more than setlistItemsMax items, so a larger index is
  // refused here and the step read never offsets by it.
  if (
    index !== null &&
    !isSafeIntegerInRange(index, 0, VJ_LIMITS.setlistItemsMax - 1)
  ) {
    return { failure: refuseRule('vj_setlist_index_invalid') };
  }
  if (setlist.id === null && index !== null) {
    return { failure: refuseRule('vj_setlist_index_invalid') };
  }
  const isPlaying = readOptionalVjFlag(payload.isPlaying);
  const isFlashConfirmed = readOptionalVjFlag(payload.isFlashConfirmed);
  if (!isPlaying.isValid || !isFlashConfirmed.isValid) {
    return { failure: refuseRule('vj_effect_flag_invalid') };
  }
  if (setlist.id === null && isPlaying.flag) {
    return { failure: refuseRule('vj_setlist_none') };
  }
  const immediate = readVjImmediateFlag('stage:setlistSelect', payload);
  if (immediate.code !== null) {
    return { failure: refuseRule(immediate.code) };
  }
  return {
    failure: null,
    setlistId: setlist.id,
    index,
    isPlaying: isPlaying.flag,
    isFlashConfirmed: isFlashConfirmed.flag,
  };
}

/** The lookup of one set list read. */
function setlistLookupOf(
  setlistId: string,
  position: VjSetlistReadPosition,
): VjCommandLookup {
  return { kind: 'setlistItem', setlistId, position };
}

/** `stage:setlistSelect`: null clears the set list (Stop); a set list with a
 *  null index and no isPlaying arms it; an index shows that step by hand;
 *  isPlaying true plays from the index (null reads as 0) after the flash
 *  check. Every select starts a fresh run. */
export const ruleSetlistSelect: VjRuleFunction = (state, payload, context) => {
  const selection = readVjSetlistSelection(payload);
  if (selection.failure !== null) {
    return selection.failure;
  }
  const { setlistId, index, isPlaying, isFlashConfirmed } = selection;
  const lookups: VjCommandLookup[] =
    setlistId === null
      ? []
      : [
          setlistLookupOf(
            setlistId,
            vjSetlistSelectReadPosition(index, isPlaying),
          ),
        ];
  if (context.lookups === null) {
    return acceptRule(state, { lookups });
  }
  const read =
    setlistId === null
      ? null
      : (context.lookups.setlistItems.get(
          vjSetlistItemKey(
            setlistId,
            vjSetlistSelectReadPosition(index, isPlaying),
          ),
        ) ?? null);
  return vjSetlistTransitionRule(
    vjSetlistSelectTransition(state, {
      setlistId,
      index,
      isPlaying,
      isFlashConfirmed,
      read,
    }),
    lookups,
  );
};

/** The read a self-checked set list command lands with: the answer at the
 *  position the state names now. A position the results do not hold answers
 *  vj_stale_setlist with the state when they hold another set list read
 *  (another remote moved the sequence between the prepare and apply steps),
 *  else vj_setlist_not_found. */
function readAtStatePosition(
  state: VjStageState,
  setlistId: string,
  position: VjSetlistReadPosition,
  lookups: VjLookupResults,
):
  | { failure: VjCommandRuleResult; read: null }
  | { failure: null; read: VjSetlistRead | null } {
  const key = vjSetlistItemKey(setlistId, position);
  if (!lookups.setlistItems.has(key)) {
    return {
      failure:
        lookups.setlistItems.size > 0
          ? refuseRule('vj_stale_setlist', state)
          : refuseRule('vj_setlist_not_found'),
      read: null,
    };
  }
  return { failure: null, read: lookups.setlistItems.get(key) ?? null };
}

/** The state rule of every command on the active set list: none answers
 *  vj_setlist_none, or vj_stale_setlist with the state in an apply step
 *  that was handed a set list read (the sequence was stopped meanwhile). */
function refuseNoActiveSetlist(
  state: VjStageState,
  lookups: VjLookupResults | null,
): VjCommandRuleResult {
  if (lookups !== null && lookups.setlistItems.size > 0) {
    return refuseRule('vj_stale_setlist', state);
  }
  return refuseRule('vj_setlist_none');
}

/** Which way a set list step moves. */
type VjSetlistStepDirection = 'next' | 'previous';

/** One set list step rule (Next or Previous): the state rule,
 *  isFlashConfirmed (a boolean or absent, else vj_effect_flag_invalid),
 *  isImmediate, one read at vjSetlistStepReadPosition (Loop wraps Next past
 *  the last step to step 1 and Previous from step 1 to the last step), then
 *  the step transition, which refuses a flashing step nobody confirmed with
 *  vj_setlist_flash_unconfirmed. Self-checked: the apply step recomputes the
 *  position from the state. */
function vjSetlistStepRule(direction: VjSetlistStepDirection): VjRuleFunction {
  const commandName: VjRemoteCommandName =
    direction === 'next' ? 'stage:setlistNext' : 'stage:setlistPrevious';
  return (state, payload, context) => {
    const setlistId = state.activeSetlistId;
    if (setlistId === null && context.lookups === null) {
      return refuseRule('vj_setlist_none');
    }
    const isFlashConfirmed = readOptionalVjFlag(payload.isFlashConfirmed);
    if (!isFlashConfirmed.isValid) {
      return refuseRule('vj_effect_flag_invalid');
    }
    const immediate = readVjImmediateFlag(commandName, payload);
    if (immediate.code !== null) {
      return refuseRule(immediate.code);
    }
    if (setlistId === null) {
      return refuseNoActiveSetlist(state, context.lookups);
    }
    const position = vjSetlistStepReadPosition(state, direction);
    const lookups = [setlistLookupOf(setlistId, position)];
    if (context.lookups === null) {
      return acceptRule(state, { lookups });
    }
    const answer = readAtStatePosition(
      state,
      setlistId,
      position,
      context.lookups,
    );
    if (answer.failure !== null) {
      return answer.failure;
    }
    return vjSetlistTransitionRule(
      vjSetlistStepTransition(state, {
        direction,
        isFlashConfirmed: isFlashConfirmed.flag,
        read: answer.read,
      }),
      lookups,
    );
  };
}

/** `stage:setlistNext`: vj_setlist_none, vj_effect_flag_invalid,
 *  vj_setlist_not_found, vj_setlist_empty, vj_setlist_end,
 *  vj_setlist_flash_unconfirmed; shows `(setlistIndex ?? -1) + 1`, step 1
 *  again past the end with Loop on. */
export const ruleSetlistNext: VjRuleFunction = vjSetlistStepRule('next');

/** `stage:setlistPrevious`: vj_setlist_none, vj_effect_flag_invalid,
 *  vj_setlist_not_found, vj_setlist_empty, vj_setlist_start,
 *  vj_setlist_flash_unconfirmed; shows `setlistIndex - 1`, the last
 *  step from step 1 with Loop on. */
export const ruleSetlistPrevious: VjRuleFunction =
  vjSetlistStepRule('previous');

/** A required boolean field: absent or anything else but a boolean answers
 *  vj_effect_flag_invalid. */
function readRequiredVjFlag(
  value: unknown,
): { code: VjSocketErrorCode; flag: false } | { code: null; flag: boolean } {
  if (typeof value !== 'boolean') {
    return { code: 'vj_effect_flag_invalid', flag: false };
  }
  return { code: null, flag: value };
}

/** `stage:setlistSetPlaying` (Play, Pause, Resume, Play again): the two
 *  flags, isImmediate, vj_setlist_none, then one read at
 *  vjSetlistSetPlayingReadPosition (none when it is null) and the playing
 *  transition. Self-checked: a position that moved between the prepare and
 *  apply steps answers vj_stale_setlist with the state. */
export const ruleSetlistSetPlaying: VjRuleFunction = (
  state,
  payload,
  context,
) => {
  const isPlaying = readRequiredVjFlag(payload.isPlaying);
  if (isPlaying.code !== null) {
    return refuseRule(isPlaying.code);
  }
  const isFlashConfirmed = readOptionalVjFlag(payload.isFlashConfirmed);
  if (!isFlashConfirmed.isValid) {
    return refuseRule('vj_effect_flag_invalid');
  }
  const immediate = readVjImmediateFlag('stage:setlistSetPlaying', payload);
  if (immediate.code !== null) {
    return refuseRule(immediate.code);
  }
  const setlistId = state.activeSetlistId;
  if (setlistId === null) {
    return refuseNoActiveSetlist(state, context.lookups);
  }
  const position = vjSetlistSetPlayingReadPosition(state, isPlaying.flag);
  const lookups =
    position === null ? [] : [setlistLookupOf(setlistId, position)];
  if (context.lookups === null) {
    return acceptRule(state, { lookups });
  }
  let read: VjSetlistRead | null = null;
  if (position === null) {
    if (context.lookups.setlistItems.size > 0) {
      return refuseRule('vj_stale_setlist', state);
    }
  } else {
    const answer = readAtStatePosition(
      state,
      setlistId,
      position,
      context.lookups,
    );
    if (answer.failure !== null) {
      return answer.failure;
    }
    read = answer.read;
  }
  return vjSetlistTransitionRule(
    vjSetlistSetPlayingTransition(state, {
      isPlaying: isPlaying.flag,
      isFlashConfirmed: isFlashConfirmed.flag,
      read,
      now: context.now,
    }),
    lookups,
  );
};

/** `stage:setlistSetLooping`: isLooping, isImmediate, vj_setlist_none; sets
 *  the playback's Loop copy on the active set list, clock kept. The gateway
 *  saves Loop on the set list row before this lands (sequences contract 5.6). */
export const ruleSetlistSetLooping: VjRuleFunction = (state, payload) => {
  const isLooping = readRequiredVjFlag(payload.isLooping);
  if (isLooping.code !== null) {
    return refuseRule(isLooping.code);
  }
  const immediate = readVjImmediateFlag('stage:setlistSetLooping', payload);
  if (immediate.code !== null) {
    return refuseRule(immediate.code);
  }
  if (state.activeSetlistId === null) {
    return refuseRule('vj_setlist_none');
  }
  return acceptRule(
    vjSetlistLoopingState(state, state.activeSetlistId, isLooping.flag),
  );
};
