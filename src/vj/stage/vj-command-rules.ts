/**
 * The command dispatch of `/vj` (contract 7.5): every remote command name
 * mapped to its rule function in the stage modules, and the lookup list
 * comparison the stage service runs between the prepare and apply steps.
 * Pure; the rules read `isImmediate` themselves (contract 7.4), so the
 * dispatch never does.
 */
import type { VjRemoteCommandName, VjStageState } from '../vj.contract';
import { ruleSetEffects, ruleSetStrobe } from './vj-effects-rules';
import {
  ruleResetLook,
  ruleSetCountdown,
  ruleSetEventCard,
  ruleSetLogo,
  ruleSetOverlay,
  ruleSetTransition,
} from './vj-look-rules';
import type {
  VjCommandLookup,
  VjCommandRuleResult,
  VjRuleContext,
  VjRuleFunction,
} from './vj-rule-kit';
import {
  ruleRecallScene,
  ruleSetlistNext,
  ruleSetlistPrevious,
  ruleSetlistSelect,
} from './vj-scene-recall';
import { ruleSetShuffle } from './vj-shuffle-rules';
import {
  ruleGoClip,
  ruleGoGenerator,
  ruleSetMix,
  ruleSetPack,
  ruleSetScreenOverride,
  ruleSwapMix,
} from './vj-source-rules';
import { ruleSetTempo } from './vj-tempo-rules';

/** The 20 remote commands to their rule functions, in contract 7.5 order. */
export const VJ_REMOTE_COMMAND_RULES: Readonly<
  Record<VjRemoteCommandName, VjRuleFunction>
> = Object.freeze({
  'stage:setPack': ruleSetPack,
  'stage:goClip': ruleGoClip,
  'stage:goGenerator': ruleGoGenerator,
  'stage:setTransition': ruleSetTransition,
  'stage:setOverlay': ruleSetOverlay,
  'stage:setEffects': ruleSetEffects,
  'stage:setStrobe': ruleSetStrobe,
  'stage:setShuffle': ruleSetShuffle,
  'stage:setTempo': ruleSetTempo,
  'stage:setMix': ruleSetMix,
  'stage:swapMix': ruleSwapMix,
  'stage:setScreenOverride': ruleSetScreenOverride,
  'stage:resetLook': ruleResetLook,
  'stage:recallScene': ruleRecallScene,
  'stage:setlistSelect': ruleSetlistSelect,
  'stage:setlistNext': ruleSetlistNext,
  'stage:setlistPrevious': ruleSetlistPrevious,
  'stage:setCountdown': ruleSetCountdown,
  'stage:setLogo': ruleSetLogo,
  'stage:setEventCard': ruleSetEventCard,
});

/** Runs one remote command's rules against the state. */
export function ruleForVjCommand(
  name: VjRemoteCommandName,
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  return VJ_REMOTE_COMMAND_RULES[name](state, payload, context);
}

/** The set list steps detect a moved position themselves and answer
 *  `vj_stale_setlist` with the state (contract 7.5, plan note 11), so the
 *  service never reads their lookups a second time. */
export const VJ_SELF_STALE_CHECKED_COMMANDS: readonly VjRemoteCommandName[] =
  Object.freeze(['stage:setlistNext', 'stage:setlistPrevious']);

/** One lookup as comparable text: ids lowercased, a clip id list sorted. */
function vjLookupText(lookup: VjCommandLookup): string {
  switch (lookup.kind) {
    case 'pack':
      return `pack:${lookup.packId.toLowerCase()}`;
    case 'clip':
      return `clip:${lookup.clipId.toLowerCase()}`;
    case 'clipsInPack':
      return `clipsInPack:${lookup.packId.toLowerCase()}:${lookup.clipIds
        .map((clipId) => clipId.toLowerCase())
        .sort()
        .join(',')}`;
    case 'packClip':
      return `packClip:${lookup.packId.toLowerCase()}:${lookup.clipId.toLowerCase()}`;
    case 'scene':
      return `scene:${lookup.sceneId.toLowerCase()}`;
    case 'setlistItem':
      return `setlistItem:${lookup.setlistId.toLowerCase()}:${lookup.index === null ? 'null' : String(lookup.index)}`;
  }
}

/** Whether two lookup lists ask for the same reads, in any order. A rule
 *  whose lookups depend on the state (the active pack of `setShuffle`,
 *  `setEventCard` and `screen:advance`) lists other reads once a change
 *  landed between the prepare and apply steps. */
export function isSameVjLookupList(
  first: readonly VjCommandLookup[],
  second: readonly VjCommandLookup[],
): boolean {
  const firstTexts = first.map(vjLookupText).sort();
  const secondTexts = second.map(vjLookupText).sort();
  return (
    firstTexts.length === secondTexts.length &&
    firstTexts.every((text, index) => text === secondTexts[index])
  );
}
