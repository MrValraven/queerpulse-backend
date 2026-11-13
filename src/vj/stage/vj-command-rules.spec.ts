import { randomUUID } from 'node:crypto';
import {
  createVjSetlistPlayback,
  createVjStageState,
  VJ_REMOTE_COMMAND_NAMES,
  type VjRemoteCommandName,
  type VjSceneLook,
  type VjSetlistPlaybackStatus,
  type VjStageState,
} from '../vj.contract';
import {
  isSameVjLookupList,
  ruleForVjCommand,
  VJ_REMOTE_COMMAND_RULES,
  VJ_SELF_STALE_CHECKED_COMMANDS,
  VJ_SETLIST_TAKEOVER_COMMANDS,
  withVjSetlistTakeover,
} from './vj-command-rules';
import { ruleSetEffects } from './vj-effects-rules';
import {
  ruleSetlistSetLooping,
  ruleSetlistSetPlaying,
} from './vj-scene-recall';
import { ruleSetPack } from './vj-source-rules';
import {
  acceptRule,
  EMPTY_VJ_LOOKUP_RESULTS,
  refuseRule,
  type VjLookupResults,
  type VjRuleContext,
} from './vj-rule-kit';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const LIVE_CLIP_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const SCENE_ID = '55555555-5555-4555-8555-555555555555';
const SETLIST_ID = '66666666-6666-4666-8666-666666666666';
const ITEM_ID = '77777777-7777-4777-8777-777777777777';

function applyContext(lookups: Partial<VjLookupResults> = {}): VjRuleContext {
  return {
    now: NOW,
    lookups: { ...EMPTY_VJ_LOOKUP_RESULTS, ...lookups },
    connectedScreenIds: new Set<string>(),
    isLeadMicOn: false,
  };
}

/** A stage on a sequence at step 2 with the given status and a live clip, a
 *  pack, a mix clip and shuffle off. A running status carries its clock. */
function sequenceState(status: VjSetlistPlaybackStatus): VjStageState {
  const base = createVjStageState(STAGE_EPOCH, NOW - 10_000);
  const clock =
    status === 'playing'
      ? {
          stepStartedAt: NOW - 2000,
          stepEndsAt: NOW + 6000,
          stepDurationMs: 8000,
          pausedRemainingMs: null,
        }
      : status === 'paused'
        ? {
            stepStartedAt: null,
            stepEndsAt: null,
            stepDurationMs: 8000,
            pausedRemainingMs: 6000,
          }
        : {};
  return {
    ...base,
    clipSequence: 4,
    activePackId: PACK_ID,
    liveClipId: LIVE_CLIP_ID,
    mix: { clipId: OTHER_CLIP_ID, amount: 0.5, blendMode: 'screen' },
    activeSetlistId: SETLIST_ID,
    setlistIndex: 1,
    setlistPlayback: {
      ...createVjSetlistPlayback(true),
      status,
      itemId: ITEM_ID,
      isFlashConfirmed: true,
      ...clock,
    },
  };
}

/** A calm look that puts another clip live. */
const SCENE_LOOK: VjSceneLook = {
  source: { kind: 'clip', clipId: OTHER_CLIP_ID },
  effects: { speed: 1, settings: {} },
  transition: { mode: 'cut', length: { unit: 'beats', value: 1 } },
  overlay: {
    text: '',
    style: 'ticker',
    isVisible: false,
    position: 'bottom',
    size: 'm',
    colorToken: 'coral',
  },
  mix: { clipId: null, amount: 0, blendMode: 'screen' },
};

/** One accepted manual pick per takeover command, run through the dispatch. */
const TAKEOVER_PICKS: [
  VjRemoteCommandName,
  Record<string, unknown>,
  Partial<VjLookupResults>,
][] = [
  ['stage:setPack', { packId: null }, {}],
  [
    'stage:goClip',
    { clipId: OTHER_CLIP_ID },
    { existingClipIds: new Set([OTHER_CLIP_ID]) },
  ],
  ['stage:goGenerator', { generatorId: 'prideFlagWave', variant: 'trans' }, {}],
  ['stage:swapMix', {}, {}],
  [
    'stage:recallScene',
    { sceneId: SCENE_ID },
    { scenes: new Map([[SCENE_ID, SCENE_LOOK]]) },
  ],
  ['stage:setShuffle', { isOn: true }, {}],
];

const PREPARE_CONTEXT: VjRuleContext = {
  now: 1000,
  lookups: null,
  connectedScreenIds: new Set<string>(),
  isLeadMicOn: false,
};

describe('vj-command-rules', () => {
  it('maps every remote command name to a rule', () => {
    expect(Object.keys(VJ_REMOTE_COMMAND_RULES)).toEqual([
      ...VJ_REMOTE_COMMAND_NAMES,
    ]);
    for (const name of VJ_REMOTE_COMMAND_NAMES) {
      expect(typeof VJ_REMOTE_COMMAND_RULES[name]).toBe('function');
    }
    expect(VJ_REMOTE_COMMAND_RULES['stage:setPack']).toBe(ruleSetPack);
    expect(VJ_REMOTE_COMMAND_RULES['stage:setEffects']).toBe(ruleSetEffects);
  });

  it('runs the named rule against the state', () => {
    const state = createVjStageState(randomUUID(), 1000);
    const refused = ruleForVjCommand(
      'stage:setEffects',
      state,
      {},
      PREPARE_CONTEXT,
    );
    expect(refused.failure?.code).toBe('vj_patch_empty');
    const packId = randomUUID();
    const accepted = ruleForVjCommand(
      'stage:setPack',
      state,
      { packId },
      PREPARE_CONTEXT,
    );
    expect(accepted.accepted?.lookups).toEqual([{ kind: 'pack', packId }]);
  });

  it('maps the two new set list commands to their rules', () => {
    expect(Object.keys(VJ_REMOTE_COMMAND_RULES)).toHaveLength(22);
    expect(VJ_REMOTE_COMMAND_RULES['stage:setlistSetPlaying']).toBe(
      ruleSetlistSetPlaying,
    );
    expect(VJ_REMOTE_COMMAND_RULES['stage:setlistSetLooping']).toBe(
      ruleSetlistSetLooping,
    );
  });

  it('leaves the stale check of the set list steps and Play to their rules', () => {
    expect([...VJ_SELF_STALE_CHECKED_COMMANDS]).toEqual([
      'stage:setlistNext',
      'stage:setlistPrevious',
      'stage:setlistSetPlaying',
    ]);
  });

  it('lists the manual picks that take a sequence over', () => {
    expect([...VJ_SETLIST_TAKEOVER_COMMANDS]).toEqual([
      'stage:setPack',
      'stage:goClip',
      'stage:goGenerator',
      'stage:swapMix',
      'stage:recallScene',
      'stage:setShuffle',
    ]);
    expect(TAKEOVER_PICKS.map(([name]) => name)).toEqual([
      ...VJ_SETLIST_TAKEOVER_COMMANDS,
    ]);
  });

  it('takes a playing, paused or flash-paused sequence over on every manual pick', () => {
    for (const status of ['playing', 'paused', 'needsFlashConsent'] as const) {
      for (const [name, payload, lookups] of TAKEOVER_PICKS) {
        const state = sequenceState(status);
        const result = ruleForVjCommand(
          name,
          state,
          { ...payload, clientId: STAGE_EPOCH, commandSequence: 3 },
          applyContext(lookups),
        );
        expect(result.failure).toBeNull();
        const playback = result.accepted?.nextState.setlistPlayback;
        expect(playback).toEqual({
          ...state.setlistPlayback,
          status: 'takenOver',
          stepStartedAt: null,
          stepEndsAt: null,
          stepDurationMs: null,
          pausedRemainingMs: null,
        });
        expect(result.accepted?.nextState.setlistIndex).toBe(1);
        expect(result.accepted?.nextState.activeSetlistId).toBe(SETLIST_ID);
        expect(result.accepted?.setlistClock).toEqual({ kind: 'keep' });
      }
    }
  });

  it('leaves manual, taken over and finished sequences as they are on a manual pick', () => {
    for (const status of ['manual', 'takenOver', 'finished'] as const) {
      for (const [name, payload, lookups] of TAKEOVER_PICKS) {
        const state = sequenceState(status);
        const result = ruleForVjCommand(
          name,
          state,
          payload,
          applyContext(lookups),
        );
        expect(result.accepted?.nextState.setlistPlayback).toEqual(
          state.setlistPlayback,
        );
      }
    }
  });

  it('leaves a running sequence alone when a pick moves nothing live', () => {
    const state = sequenceState('playing');
    const samePack = ruleForVjCommand(
      'stage:setPack',
      state,
      { packId: PACK_ID },
      applyContext({ packs: new Map([[PACK_ID, { eventId: null }]]) }),
    );
    expect(samePack.accepted?.nextState.setlistPlayback.status).toBe('playing');
    const shuffleOff = ruleForVjCommand(
      'stage:setShuffle',
      state,
      { isOn: false },
      applyContext(),
    );
    expect(shuffleOff.accepted?.nextState.setlistPlayback.status).toBe(
      'playing',
    );
    const shuffleAlreadyOn = ruleForVjCommand(
      'stage:setShuffle',
      { ...state, shuffle: { ...state.shuffle, isOn: true } },
      { isOn: true },
      applyContext(),
    );
    expect(shuffleAlreadyOn.accepted?.nextState.setlistPlayback.status).toBe(
      'playing',
    );
    const effects = ruleForVjCommand(
      'stage:setEffects',
      state,
      { speed: 2 },
      applyContext(),
    );
    expect(effects.accepted?.nextState.setlistPlayback).toEqual(
      state.setlistPlayback,
    );
  });

  it('takes over when shuffle goes from off to on and leaves it when shuffle goes from on to off', () => {
    for (const status of ['playing', 'paused', 'needsFlashConsent'] as const) {
      const shuffleOffState = sequenceState(status);
      expect(shuffleOffState.shuffle.isOn).toBe(false);
      const turnedOn = ruleForVjCommand(
        'stage:setShuffle',
        shuffleOffState,
        { isOn: true },
        applyContext(),
      );
      expect(turnedOn.accepted?.nextState.shuffle.isOn).toBe(true);
      expect(turnedOn.accepted?.nextState.setlistPlayback.status).toBe(
        'takenOver',
      );

      const shuffleOnState = {
        ...shuffleOffState,
        shuffle: { ...shuffleOffState.shuffle, isOn: true },
      };
      const turnedOff = ruleForVjCommand(
        'stage:setShuffle',
        shuffleOnState,
        { isOn: false },
        applyContext(),
      );
      expect(turnedOff.accepted?.nextState.shuffle.isOn).toBe(false);
      expect(turnedOff.accepted?.nextState.setlistPlayback).toEqual(
        shuffleOnState.setlistPlayback,
      );
    }
  });

  it('takes the sequence over on a scene recalled by hand, a look with no source included', () => {
    const sourceless = {
      ...SCENE_LOOK,
      source: null,
    };
    const context = applyContext({ scenes: new Map([[SCENE_ID, sourceless]]) });
    for (const status of ['playing', 'paused', 'needsFlashConsent'] as const) {
      const state = sequenceState(status);
      const result = ruleForVjCommand(
        'stage:recallScene',
        state,
        { sceneId: SCENE_ID },
        context,
      );
      expect(result.failure).toBeNull();
      const nextState = result.accepted?.nextState;
      expect(nextState?.liveClipId).toBe(LIVE_CLIP_ID);
      expect(nextState?.clipSequence).toBe(state.clipSequence);
      expect(nextState?.activePackId).toBe(PACK_ID);
      expect(nextState?.setlistIndex).toBe(1);
      expect(nextState?.setlistPlayback).toEqual({
        ...state.setlistPlayback,
        status: 'takenOver',
        stepStartedAt: null,
        stepEndsAt: null,
        stepDurationMs: null,
        pausedRemainingMs: null,
      });
      expect(result.accepted?.isLookSwitch).toBe(true);
      const again = withVjSetlistTakeover('stage:recallScene', state, result);
      expect(again).toBe(result);
    }
    for (const status of ['manual', 'takenOver', 'finished'] as const) {
      const state = sequenceState(status);
      const result = ruleForVjCommand(
        'stage:recallScene',
        state,
        { sceneId: SCENE_ID },
        context,
      );
      expect(result.accepted?.nextState.setlistPlayback).toEqual(
        state.setlistPlayback,
      );
    }
    const unknownScene = ruleForVjCommand(
      'stage:recallScene',
      sequenceState('playing'),
      { sceneId: SCENE_ID },
      applyContext({ scenes: new Map([[SCENE_ID, null]]) }),
    );
    expect(unknownScene.failure?.code).toBe('vj_scene_not_found');
  });

  it('keeps the live-source rule for every other takeover command', () => {
    const state = sequenceState('playing');
    const unchanged = acceptRule({ ...state, revision: state.revision + 1 });
    for (const name of VJ_SETLIST_TAKEOVER_COMMANDS) {
      if (name === 'stage:recallScene') {
        continue;
      }
      expect(withVjSetlistTakeover(name, state, unchanged)).toBe(unchanged);
    }
    const recalled = withVjSetlistTakeover(
      'stage:recallScene',
      state,
      unchanged,
    );
    expect(recalled.accepted?.nextState.setlistPlayback.status).toBe(
      'takenOver',
    );
  });

  it('never takes over outside the listed commands, on a refusal or twice', () => {
    const state = sequenceState('playing');
    const moved = { ...state, liveClipId: OTHER_CLIP_ID };
    const outside = withVjSetlistTakeover(
      'stage:setMix',
      state,
      acceptRule(moved),
    );
    expect(outside.accepted?.nextState).toBe(moved);

    const refusal = refuseRule('vj_clip_not_found');
    expect(withVjSetlistTakeover('stage:goClip', state, refusal)).toBe(refusal);

    const once = withVjSetlistTakeover(
      'stage:goClip',
      state,
      acceptRule(moved),
    );
    expect(once.accepted?.nextState.setlistPlayback.status).toBe('takenOver');
    const twice = withVjSetlistTakeover('stage:goClip', state, once);
    expect(twice).toBe(once);
  });

  it('compares lookup lists by their reads in any order and case', () => {
    const packId = randomUUID();
    const otherPackId = randomUUID();
    const clipIds = [randomUUID(), randomUUID()];
    expect(isSameVjLookupList([], [])).toBe(true);
    expect(
      isSameVjLookupList(
        [
          { kind: 'pack', packId },
          { kind: 'clipsInPack', packId, clipIds },
        ],
        [
          {
            kind: 'clipsInPack',
            packId: packId.toUpperCase(),
            clipIds: [...clipIds].reverse(),
          },
          { kind: 'pack', packId },
        ],
      ),
    ).toBe(true);
    expect(
      isSameVjLookupList(
        [{ kind: 'clipsInPack', packId, clipIds }],
        [{ kind: 'clipsInPack', packId: otherPackId, clipIds }],
      ),
    ).toBe(false);
    const atZero = { kind: 'index' as const, index: 0, wrapsToFirst: false };
    expect(
      isSameVjLookupList(
        [
          {
            kind: 'setlistItem',
            setlistId: packId,
            position: { kind: 'count' },
          },
        ],
        [{ kind: 'setlistItem', setlistId: packId, position: atZero }],
      ),
    ).toBe(false);
    expect(
      isSameVjLookupList(
        [{ kind: 'setlistItem', setlistId: packId, position: atZero }],
        [
          {
            kind: 'setlistItem',
            setlistId: packId,
            position: { ...atZero, wrapsToFirst: true },
          },
        ],
      ),
    ).toBe(false);
    expect(
      isSameVjLookupList(
        [
          {
            kind: 'setlistItem',
            setlistId: packId.toUpperCase(),
            position: { kind: 'last' },
          },
        ],
        [
          {
            kind: 'setlistItem',
            setlistId: packId,
            position: { kind: 'last' },
          },
        ],
      ),
    ).toBe(true);
    expect(isSameVjLookupList([{ kind: 'pack', packId }], [])).toBe(false);
  });
});
