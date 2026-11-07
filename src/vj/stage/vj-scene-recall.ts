/**
 * Scene recall and set list steps (contract 3.7 recall, 7.5 rows for
 * `stage:recallScene`, `stage:setlistSelect`, `stage:setlistNext` and
 * `stage:setlistPrevious`). Every recall is a look switch (contract 7.4 step
 * 2) and writes `overlay.hideAt: null`, so its accepted change carries
 * `isLookSwitch: true` and `overlayHideAfterMs: null`.
 *
 * In the prepare step (`context.lookups` null) a rule runs its field rules,
 * lists its lookups and answers the state unchanged; the apply step reruns
 * every check and reads the scene or set list item from the lookups.
 */
import {
  VJ_LIMITS,
  type VjEffectSettings,
  type VjSceneLook,
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
  type VjCommandLookup,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleFunction,
  type VjSetlistItemRead,
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

/** The `stage:setlistSelect` fields once their shape is checked. */
type VjSetlistSelection =
  | { failure: VjCommandRuleResult; setlistId: null; index: null }
  | { failure: null; setlistId: string | null; index: number | null };

/** Field rules of `stage:setlistSelect`, in the frame table's order. */
function readVjSetlistSelection(
  payload: Record<string, unknown>,
): VjSetlistSelection {
  const setlist = readNullableUuid(payload.setlistId);
  if (!setlist.isValid) {
    return refuseSelection('vj_setlist_not_found');
  }
  const index = payload.index;
  const isIndexNull = index === null;
  // No set list holds more than setlistItemsMax items, so a larger index is
  // refused here and the item read never offsets by it.
  const isIndexShaped = isSafeIntegerInRange(
    index,
    0,
    VJ_LIMITS.setlistItemsMax - 1,
  );
  if (!isIndexNull && !isIndexShaped) {
    return refuseSelection('vj_setlist_index_invalid');
  }
  if (setlist.id === null && !isIndexNull) {
    return refuseSelection('vj_setlist_index_invalid');
  }
  return {
    failure: null,
    setlistId: setlist.id,
    index: index,
  };
}

/** A selection refusal with its code. */
function refuseSelection(
  code: 'vj_setlist_not_found' | 'vj_setlist_index_invalid',
): VjSetlistSelection {
  return { failure: refuseRule(code), setlistId: null, index: null };
}

/** The look at an index of a read set list, or the code that refuses it. */
function lookAtSetlistIndex(
  read: VjSetlistItemRead,
  index: number,
  pastEndCode: 'vj_setlist_end' | 'vj_setlist_index_invalid',
):
  | { failure: VjCommandRuleResult; look: null }
  | { failure: null; look: VjSceneLook } {
  if (read.itemCount === 0) {
    return { failure: refuseRule('vj_setlist_empty'), look: null };
  }
  if (index >= read.itemCount) {
    return { failure: refuseRule(pastEndCode), look: null };
  }
  if (read.look === null) {
    return { failure: refuseRule('vj_setlist_index_invalid'), look: null };
  }
  return { failure: null, look: read.look };
}

/** `stage:setlistSelect`: null clears the set list; a set list with a null
 *  index arms it; a number recalls that item's scene. */
export const ruleSetlistSelect: VjRuleFunction = (state, payload, context) => {
  const selection = readVjSetlistSelection(payload);
  if (selection.failure !== null) {
    return selection.failure;
  }
  const immediate = readVjImmediateFlag('stage:setlistSelect', payload);
  if (immediate.code !== null) {
    return refuseRule(immediate.code);
  }
  const { setlistId, index } = selection;
  if (setlistId === null) {
    return acceptRule({ ...state, activeSetlistId: null, setlistIndex: null });
  }
  const lookups: VjCommandLookup[] = [
    { kind: 'setlistItem', setlistId, index },
  ];
  const changeOptions =
    index === null ? { lookups } : { lookups, ...RECALL_CHANGE_OPTIONS };
  if (context.lookups === null) {
    return acceptRule(state, changeOptions);
  }
  const read =
    context.lookups.setlistItems.get(vjSetlistItemKey(setlistId, index)) ??
    null;
  if (read === null) {
    return refuseRule('vj_setlist_not_found');
  }
  if (index === null) {
    return acceptRule(
      { ...state, activeSetlistId: setlistId, setlistIndex: null },
      changeOptions,
    );
  }
  const item = lookAtSetlistIndex(read, index, 'vj_setlist_index_invalid');
  if (item.failure !== null) {
    return item.failure;
  }
  return acceptRule(
    {
      ...recallVjScene(state, item.look),
      activeSetlistId: setlistId,
      setlistIndex: index,
    },
    changeOptions,
  );
};

/** Which way a set list step moves. */
type VjSetlistStepDirection = 'next' | 'previous';

/** The item a step targets from the state, or the state rule that refuses it.
 *  Previous from an armed set list (`setlistIndex` null) targets a count-only
 *  read (index null): the apply step answers vj_setlist_empty for an empty
 *  set list and vj_setlist_start otherwise, in the contract's order. */
function vjSetlistStepTarget(
  state: VjStageState,
  direction: VjSetlistStepDirection,
):
  | {
      code: 'vj_setlist_none' | 'vj_setlist_start';
      setlistId: null;
      index: null;
    }
  | { code: null; setlistId: string; index: number | null } {
  if (state.activeSetlistId === null) {
    return { code: 'vj_setlist_none', setlistId: null, index: null };
  }
  if (direction === 'next') {
    return {
      code: null,
      setlistId: state.activeSetlistId,
      index: (state.setlistIndex ?? -1) + 1,
    };
  }
  if (state.setlistIndex === null) {
    return { code: null, setlistId: state.activeSetlistId, index: null };
  }
  if (state.setlistIndex === 0) {
    return { code: 'vj_setlist_start', setlistId: null, index: null };
  }
  return {
    code: null,
    setlistId: state.activeSetlistId,
    index: state.setlistIndex - 1,
  };
}

/** The apply step of a set list step (note 11): the lookups were read for the
 *  target the prepare step computed; a state that now targets another item
 *  (another remote stepped meanwhile) answers vj_stale_setlist with the state. */
function applyVjSetlistStep(
  state: VjStageState,
  direction: VjSetlistStepDirection,
  lookups: VjLookupResults,
  commandLookups: VjCommandLookup[],
): VjCommandRuleResult {
  const hasHandedItem = lookups.setlistItems.size > 0;
  const target = vjSetlistStepTarget(state, direction);
  if (target.code !== null) {
    return hasHandedItem
      ? refuseRule('vj_stale_setlist', state)
      : refuseRule(target.code);
  }
  const key = vjSetlistItemKey(target.setlistId, target.index);
  if (!lookups.setlistItems.has(key)) {
    return hasHandedItem
      ? refuseRule('vj_stale_setlist', state)
      : refuseRule('vj_setlist_not_found');
  }
  const read = lookups.setlistItems.get(key) ?? null;
  if (read === null) {
    return refuseRule('vj_setlist_not_found');
  }
  if (target.index === null) {
    return refuseRule(
      read.itemCount === 0 ? 'vj_setlist_empty' : 'vj_setlist_start',
    );
  }
  const item = lookAtSetlistIndex(
    read,
    target.index,
    direction === 'next' ? 'vj_setlist_end' : 'vj_setlist_index_invalid',
  );
  if (item.failure !== null) {
    return item.failure;
  }
  return acceptRule(
    { ...recallVjScene(state, item.look), setlistIndex: target.index },
    { lookups: commandLookups, ...RECALL_CHANGE_OPTIONS },
  );
}

/** One set list step rule: state rules, isImmediate, the item lookup, recall. */
function vjSetlistStepRule(direction: VjSetlistStepDirection): VjRuleFunction {
  const commandName =
    direction === 'next' ? 'stage:setlistNext' : 'stage:setlistPrevious';
  return (state, payload, context) => {
    const target = vjSetlistStepTarget(state, direction);
    if (target.code !== null && context.lookups === null) {
      return refuseRule(target.code);
    }
    const immediate = readVjImmediateFlag(commandName, payload);
    if (immediate.code !== null) {
      return refuseRule(immediate.code);
    }
    const commandLookups: VjCommandLookup[] =
      target.code === null
        ? [
            {
              kind: 'setlistItem',
              setlistId: target.setlistId,
              index: target.index,
            },
          ]
        : [];
    if (context.lookups === null) {
      return acceptRule(state, {
        lookups: commandLookups,
        ...RECALL_CHANGE_OPTIONS,
      });
    }
    return applyVjSetlistStep(
      state,
      direction,
      context.lookups,
      commandLookups,
    );
  };
}

/** `stage:setlistNext`: vj_setlist_none, vj_setlist_empty, vj_setlist_end;
 *  recalls `(setlistIndex ?? -1) + 1` and sets `setlistIndex`. */
export const ruleSetlistNext: VjRuleFunction = vjSetlistStepRule('next');

/** `stage:setlistPrevious`: vj_setlist_none, vj_setlist_empty,
 *  vj_setlist_start; recalls `setlistIndex - 1`. */
export const ruleSetlistPrevious: VjRuleFunction =
  vjSetlistStepRule('previous');
