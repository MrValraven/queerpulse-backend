/**
 * The command dispatch of `/vj` (contract 7.5): every remote command name
 * mapped to its rule function in the stage modules, the sequence takeover
 * of the manual picks (sequences contract 5.4), and the lookup list
 * comparison the stage service runs between the prepare and apply steps.
 * Pure; the rules read `isImmediate` themselves (contract 7.4), so the
 * dispatch never does.
 */
import {
  vjSetlistTakeoverState,
  type VjRemoteCommandName,
  type VjSetlistPlaybackStatus,
  type VjStageState,
} from '../vj.contract';
import { ruleSetEffects, ruleSetStrobe } from './vj-effects-rules';
import {
  ruleResetLook,
  ruleSetCountdown,
  ruleSetEventCard,
  ruleSetLogo,
  ruleSetOverlay,
  ruleSetTransition,
} from './vj-look-rules';
import {
  vjSetlistItemKey,
  type VjCommandLookup,
  type VjCommandRuleResult,
  type VjRuleContext,
  type VjRuleFunction,
} from './vj-rule-kit';
import {
  ruleRecallScene,
  ruleSetlistNext,
  ruleSetlistPrevious,
  ruleSetlistSelect,
  ruleSetlistSetLooping,
  ruleSetlistSetPlaying,
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

/** The 22 remote commands to their rule functions, in VJ_REMOTE_COMMAND_NAMES order. */
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
  'stage:setlistSetPlaying': ruleSetlistSetPlaying,
  'stage:setlistSetLooping': ruleSetlistSetLooping,
  'stage:setCountdown': ruleSetCountdown,
  'stage:setLogo': ruleSetLogo,
  'stage:setEventCard': ruleSetEventCard,
});

/** The manual picks that take a running sequence over (sequences contract
 *  5.4, design 13.1): a clip, a generator, a pack, the mix swap (it changes
 *  the live clip, contract call 11), a scene recalled outside the sequence
 *  and shuffle turned on. */
export const VJ_SETLIST_TAKEOVER_COMMANDS: readonly VjRemoteCommandName[] =
  Object.freeze([
    'stage:setPack',
    'stage:goClip',
    'stage:goGenerator',
    'stage:swapMix',
    'stage:recallScene',
    'stage:setShuffle',
  ]);

/** The statuses a manual pick takes over; manual, takenOver and finished never change. */
const VJ_SETLIST_TAKEOVER_STATUSES: readonly VjSetlistPlaybackStatus[] =
  Object.freeze(['playing', 'paused', 'needsFlashConsent']);

/** A scene recalled by hand takes the sequence over whatever it changes
 *  (design 13.1): the operator chose a look, and the next scene step would
 *  replace it. Index, itemId, isFlashConfirmed and isLooping are kept; every
 *  clock field is cleared, as vjSetlistTakeoverState clears them. */
function vjSetlistSceneTakeoverState(next: VjStageState): VjStageState {
  if (!VJ_SETLIST_TAKEOVER_STATUSES.includes(next.setlistPlayback.status)) {
    return next;
  }
  return {
    ...next,
    setlistPlayback: {
      ...next.setlistPlayback,
      status: 'takenOver',
      stepStartedAt: null,
      stepEndsAt: null,
      stepDurationMs: null,
      pausedRemainingMs: null,
    },
  };
}

/** A takeover command's accepted change with the sequence taken over: a
 *  `playing`, `paused` or `needsFlashConsent` sequence becomes `takenOver`.
 *  An accepted `stage:recallScene` always takes it over, a look with no
 *  source included; the other five commands go through
 *  vjSetlistTakeoverState (the live source moved, or shuffle went from off
 *  to on). Refusals, other commands and every other status come back as
 *  they are. Running it twice changes nothing more. */
export function withVjSetlistTakeover(
  name: VjRemoteCommandName,
  previousState: VjStageState,
  result: VjCommandRuleResult,
): VjCommandRuleResult {
  if (
    result.accepted === null ||
    !VJ_SETLIST_TAKEOVER_COMMANDS.includes(name)
  ) {
    return result;
  }
  const nextState =
    name === 'stage:recallScene'
      ? vjSetlistSceneTakeoverState(result.accepted.nextState)
      : vjSetlistTakeoverState(previousState, result.accepted.nextState);
  if (nextState === result.accepted.nextState) {
    return result;
  }
  return { failure: null, accepted: { ...result.accepted, nextState } };
}

/** Runs one remote command's rules against the state, with the sequence
 *  takeover applied to the manual picks. */
export function ruleForVjCommand(
  name: VjRemoteCommandName,
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  return withVjSetlistTakeover(
    name,
    state,
    VJ_REMOTE_COMMAND_RULES[name](state, payload, context),
  );
}

/** The set list commands that read at a position the state names detect a
 *  moved position themselves and answer `vj_stale_setlist` with the state
 *  (contract 7.5, plan note 11, sequences contract 5.3), so the service
 *  never reads their lookups a second time. */
export const VJ_SELF_STALE_CHECKED_COMMANDS: readonly VjRemoteCommandName[] =
  Object.freeze([
    'stage:setlistNext',
    'stage:setlistPrevious',
    'stage:setlistSetPlaying',
  ]);

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
      return `setlistItem:${vjSetlistItemKey(lookup.setlistId, lookup.position)}`;
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
