import {
  createVjSetlistPlayback,
  createVjStageState,
  stampVjSetlistClock,
  VJ_LIMITS,
  type VjSceneLook,
  type VjSetlistPlayback,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjSetlistStepRead,
  type VjStageState,
} from '../vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  vjSetlistItemKey,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleContext,
} from './vj-rule-kit';
import {
  recallVjScene,
  ruleRecallScene,
  ruleSetlistNext,
  ruleSetlistPrevious,
  ruleSetlistSelect,
  ruleSetlistSetLooping,
  ruleSetlistSetPlaying,
  showVjSetlistStep,
  vjSetlistTransitionChange,
} from './vj-scene-recall';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const LIVE_CLIP_ID = '22222222-2222-4222-8222-222222222222';
const SCENE_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const MIX_CLIP_ID = '44444444-4444-4444-8444-444444444444';
const PACK_ID = '55555555-5555-4555-8555-555555555555';
const SCENE_ID = '66666666-6666-4666-8666-666666666666';
const SETLIST_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_SETLIST_ID = '88888888-8888-4888-8888-888888888888';
const SCREEN_ID = '99999999-9999-4999-8999-999999999999';
const STEP_CLIP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_IDS = [
  'bbbbbbbb-bbbb-4bbb-8bbb-000000000000',
  'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
];
function itemIdAt(index: number): string {
  const itemId = ITEM_IDS[index];
  if (itemId === undefined) {
    throw new Error(`no item at ${index}`);
  }
  return itemId;
}
/** Eight seconds, the sequence default. */
const EIGHT_SECONDS_MS = 8000;
/** Sixteen beats at the busy stage's 128 bpm: Math.round(16 * 60000 / 128). */
const SIXTEEN_BEATS_MS = 7500;
const COMMAND_FIELDS = { clientId: STAGE_EPOCH, commandSequence: 4 };

const PREPARE_CONTEXT: VjRuleContext = {
  now: NOW,
  lookups: null,
  connectedScreenIds: new Set<string>(),
  isLeadMicOn: false,
};

/** A busy stage: a pack, a live clip, blackout, strobe, tempo, shuffle,
 *  countdown, logo, card and an override, all of which a recall keeps. */
function busyState(): VjStageState {
  const base = createVjStageState(STAGE_EPOCH, NOW);
  return {
    ...base,
    revision: 12,
    clipSequence: 5,
    activePackId: PACK_ID,
    liveClipId: LIVE_CLIP_ID,
    liveSince: NOW - 4000,
    recentClipIds: [LIVE_CLIP_ID],
    overlay: {
      ...base.overlay,
      text: 'Welcome in',
      isVisible: true,
      hideAt: NOW + 9000,
    },
    countdown: { isVisible: true, targetAt: NOW + 60_000, label: 'Doors' },
    logo: { isVisible: true, corner: 'topLeft' },
    eventCard: { isVisible: true, kind: 'qr' },
    effects: {
      ...base.effects,
      isBlackout: true,
      isStrobing: true,
      strobeStartedAt: NOW - 1000,
      settings: { invert: { isOn: true, amount: 1, variant: 'steady' } },
    },
    tempo: { ...base.tempo, bpm: 128, quantize: 'beat' },
    shuffle: { ...base.shuffle, isOn: true },
    screenOverrides: {
      [SCREEN_ID]: {
        clipId: LIVE_CLIP_ID,
        generatorId: null,
        generatorVariant: null,
      },
    },
  };
}

function sceneLook(source: VjSceneLook['source']): VjSceneLook {
  return {
    source,
    effects: {
      speed: 2,
      settings: { glitch: { isOn: true, amount: 0.6, variant: null } },
    },
    transition: { mode: 'cut', length: { unit: 'beats', value: 4 } },
    overlay: {
      text: 'Last call',
      style: 'ticker',
      isVisible: true,
      position: 'bottom',
      size: 'm',
      colorToken: 'coral',
    },
    mix: { clipId: MIX_CLIP_ID, amount: 0.25, blendMode: 'screen' },
  };
}

function lookupsWith(fields: Partial<VjLookupResults>): VjLookupResults {
  return { ...EMPTY_VJ_LOOKUP_RESULTS, ...fields };
}

function applyContext(lookups: VjLookupResults): VjRuleContext {
  return { ...PREPARE_CONTEXT, lookups };
}

/** A look that cannot flash: a cut and no effect on. */
function calmLook(source: VjSceneLook['source']): VjSceneLook {
  return {
    ...sceneLook(source),
    effects: { speed: 1.5, settings: {} },
  };
}

/** A look that flashes through its dip-to-white transition. */
function flashingLook(): VjSceneLook {
  return {
    ...calmLook({ kind: 'clip', clipId: SCENE_CLIP_ID }),
    transition: { mode: 'dipWhite', length: { unit: 'beats', value: 1 } },
  };
}

function sceneStep(
  index: number,
  look: VjSceneLook = calmLook({ kind: 'clip', clipId: SCENE_CLIP_ID }),
): VjSetlistStepRead {
  return {
    kind: 'scene',
    itemId: itemIdAt(index),
    index,
    sceneId: SCENE_ID,
    look,
    duration: { kind: 'seconds', value: 8 },
  };
}

function clipStep(index: number): VjSetlistStepRead {
  return {
    kind: 'clip',
    itemId: itemIdAt(index),
    index,
    clipId: STEP_CLIP_ID,
    duration: { kind: 'beats', value: 16 },
  };
}

function setlistRead(
  step: VjSetlistStepRead | null,
  fields: Partial<VjSetlistRead> = {},
): VjSetlistRead {
  return {
    setlistId: SETLIST_ID,
    isLooping: false,
    stepDuration: { kind: 'seconds', value: 8 },
    itemIds: [...ITEM_IDS],
    step,
    ...fields,
  };
}

function atIndex(index: number, wrapsToFirst = false): VjSetlistReadPosition {
  return { kind: 'index', index, wrapsToFirst };
}

function setlistLookups(
  entries: [string, VjSetlistReadPosition, VjSetlistRead | null][],
): VjLookupResults {
  return lookupsWith({
    setlistItems: new Map(
      entries.map(([setlistId, position, read]) => [
        vjSetlistItemKey(setlistId, position),
        read,
      ]),
    ),
  });
}

/** One read handed to the apply step. */
function readContext(
  position: VjSetlistReadPosition,
  read: VjSetlistRead | null,
): VjRuleContext {
  return applyContext(setlistLookups([[SETLIST_ID, position, read]]));
}

/** The busy stage with the set list active, shuffle off, at `index`, with
 *  the playback fields given (the rest default). */
function sequenceState(
  index: number | null,
  playback: Partial<VjSetlistPlayback> = {},
): VjStageState {
  const state = busyState();
  return {
    ...state,
    shuffle: { ...state.shuffle, isOn: false },
    activeSetlistId: SETLIST_ID,
    setlistIndex: index,
    setlistPlayback: {
      ...createVjSetlistPlayback(false),
      itemId: index === null ? null : itemIdAt(index),
      ...playback,
    },
  };
}

/** A `playing` sequence at `index` whose step ends `remainingMs` from NOW. */
function playingState(index: number, remainingMs = 3000): VjStageState {
  return sequenceState(index, {
    status: 'playing',
    stepStartedAt: NOW + remainingMs - EIGHT_SECONDS_MS,
    stepEndsAt: NOW + remainingMs,
    stepDurationMs: EIGHT_SECONDS_MS,
  });
}

/** The accepted state as the landing writes it: the clock stamped at `stampAt`. */
function landedState(
  result: VjCommandRuleResult,
  stampAt: number = NOW,
): VjStageState {
  if (result.accepted === null) {
    throw new Error(`refused with ${failureCode(result)}`);
  }
  return {
    ...result.accepted.nextState,
    setlistPlayback: stampVjSetlistClock(
      result.accepted.nextState.setlistPlayback,
      result.accepted.setlistClock,
      stampAt,
    ),
  };
}

/** A landed `playing` run whose clock started at `stampAt` with `remainingMs` left of `durationMs`. */
function expectRunningClock(
  landed: VjStageState,
  durationMs: number,
  remainingMs: number,
  stampAt: number = NOW,
): void {
  const playback = landed.setlistPlayback;
  expect(playback.status).toBe('playing');
  expect(playback.stepEndsAt).toBe(stampAt + remainingMs);
  expect(playback.stepStartedAt).toBe(stampAt + remainingMs - durationMs);
  expect(playback.stepDurationMs).toBe(durationMs);
  expect(playback.pausedRemainingMs).toBeNull();
}

function failureCode(result: VjCommandRuleResult): string | null {
  return result.failure === null ? null : result.failure.code;
}

function acceptedState(result: VjCommandRuleResult): VjStageState {
  if (result.accepted === null) {
    throw new Error(`refused with ${failureCode(result)}`);
  }
  return result.accepted.nextState;
}

describe('vj scene recall and set list steps', () => {
  it('replaces effects, transition, overlay and mix and keeps the pack', () => {
    const state = busyState();
    const look = sceneLook({ kind: 'clip', clipId: SCENE_CLIP_ID });
    const recalled = recallVjScene(state, look);

    expect(recalled.liveClipId).toBe(SCENE_CLIP_ID);
    expect(recalled.liveGeneratorId).toBeNull();
    expect(recalled.clipSequence).toBe(6);
    expect(recalled.recentClipIds).toEqual([SCENE_CLIP_ID, LIVE_CLIP_ID]);
    expect(recalled.effects.speed).toBe(2);
    expect(recalled.effects.settings).toEqual({
      glitch: { isOn: true, amount: 0.6, variant: null },
    });
    expect(recalled.transition).toEqual(look.transition);
    expect(recalled.overlay).toEqual({ ...look.overlay, hideAt: null });
    expect(recalled.mix).toEqual(look.mix);

    expect(recalled.activePackId).toBe(PACK_ID);
    expect(recalled.effects.isBlackout).toBe(true);
    expect(recalled.effects.isStrobing).toBe(true);
    expect(recalled.effects.strobeStartedAt).toBe(
      state.effects.strobeStartedAt,
    );
    expect(recalled.tempo).toEqual(state.tempo);
    expect(recalled.shuffle).toEqual(state.shuffle);
    expect(recalled.countdown).toEqual(state.countdown);
    expect(recalled.logo).toEqual(state.logo);
    expect(recalled.eventCard).toEqual(state.eventCard);
    expect(recalled.screenOverrides).toEqual(state.screenOverrides);
    expect(recalled.activeSetlistId).toBe(state.activeSetlistId);

    recalled.effects.settings.glitch!.amount = 0.9;
    expect(look.effects.settings.glitch!.amount).toBe(0.6);
  });

  it('keeps the live source for a look with no source', () => {
    const state = busyState();
    const recalled = recallVjScene(state, sceneLook(null));
    expect(recalled.liveClipId).toBe(LIVE_CLIP_ID);
    expect(recalled.clipSequence).toBe(state.clipSequence);
    expect(recalled.recentClipIds).toEqual(state.recentClipIds);
    expect(recalled.effects.speed).toBe(2);

    const generator = recallVjScene(
      state,
      sceneLook({
        kind: 'generator',
        generatorId: 'prideFlagWave',
        generatorVariant: 'trans',
      }),
    );
    expect(generator.liveClipId).toBeNull();
    expect(generator.liveGeneratorId).toBe('prideFlagWave');
    expect(generator.liveGeneratorVariant).toBe('trans');
    expect(generator.clipSequence).toBe(state.clipSequence + 1);
    expect(generator.recentClipIds).toEqual(state.recentClipIds);
  });

  it('refuses a malformed scene id before any read', () => {
    for (const sceneId of [undefined, null, 'scene', 42, `${SCENE_ID} `]) {
      const result = ruleRecallScene(
        busyState(),
        { sceneId, ...COMMAND_FIELDS },
        PREPARE_CONTEXT,
      );
      expect(failureCode(result)).toBe('vj_scene_not_found');
    }

    const prepared = ruleRecallScene(
      busyState(),
      { sceneId: SCENE_ID.toUpperCase(), ...COMMAND_FIELDS },
      PREPARE_CONTEXT,
    );
    expect(prepared.accepted?.lookups).toEqual([
      { kind: 'scene', sceneId: SCENE_ID },
    ]);

    const unknown = ruleRecallScene(
      busyState(),
      { sceneId: SCENE_ID, ...COMMAND_FIELDS },
      applyContext(lookupsWith({ scenes: new Map([[SCENE_ID, null]]) })),
    );
    expect(failureCode(unknown)).toBe('vj_scene_not_found');

    const immediate = ruleRecallScene(
      busyState(),
      { sceneId: SCENE_ID, isImmediate: true, ...COMMAND_FIELDS },
      PREPARE_CONTEXT,
    );
    expect(failureCode(immediate)).toBe('vj_immediate_not_allowed');
  });

  it('puts a clip step on screen through the live source only', () => {
    const state = busyState();
    const shown = showVjSetlistStep(state, {
      kind: 'clip',
      clipId: STEP_CLIP_ID.toUpperCase(),
    });
    expect(shown.isLookSwitch).toBe(true);
    expect(shown.overlayHideAfterMs).toBeUndefined();
    expect(shown.nextState.liveClipId).toBe(STEP_CLIP_ID);
    expect(shown.nextState.liveGeneratorId).toBeNull();
    expect(shown.nextState.clipSequence).toBe(state.clipSequence + 1);
    expect(shown.nextState.recentClipIds).toEqual([STEP_CLIP_ID, LIVE_CLIP_ID]);
    expect(shown.nextState.activePackId).toBe(PACK_ID);
    expect(shown.nextState.overlay).toEqual(state.overlay);
    expect(shown.nextState.effects).toEqual(state.effects);
    expect(shown.nextState.transition).toEqual(state.transition);
    expect(shown.nextState.mix).toEqual(state.mix);

    const scene = showVjSetlistStep(state, {
      kind: 'scene',
      look: calmLook({ kind: 'clip', clipId: SCENE_CLIP_ID }),
    });
    expect(scene.isLookSwitch).toBe(true);
    expect(scene.overlayHideAfterMs).toBeNull();
    expect(scene.nextState.liveClipId).toBe(SCENE_CLIP_ID);
    expect(scene.nextState.overlay.hideAt).toBeNull();

    const nothing = showVjSetlistStep(state, null);
    expect(nothing).toEqual({
      nextState: state,
      isLookSwitch: false,
      overlayHideAfterMs: undefined,
    });
  });

  it('builds the landing change of a transition with its clock and the timer step end', () => {
    const state = sequenceState(0, { status: 'playing' });
    const transition = {
      nextState: state,
      show: { kind: 'clip' as const, clipId: STEP_CLIP_ID },
      clock: {
        kind: 'start' as const,
        durationMs: SIXTEEN_BEATS_MS,
        remainingMs: SIXTEEN_BEATS_MS,
      },
    };
    const lookups = [
      {
        kind: 'setlistItem' as const,
        setlistId: SETLIST_ID,
        position: atIndex(1),
      },
    ];
    const command = vjSetlistTransitionChange(transition, lookups);
    expect(command.scheduledAt).toBeNull();
    expect(command.setlistClock).toEqual(transition.clock);
    expect(command.lookups).toBe(lookups);
    expect(command.isImmediate).toBe(false);
    expect(command.isLookSwitch).toBe(true);
    expect(command.nextState.liveClipId).toBe(STEP_CLIP_ID);

    const timer = vjSetlistTransitionChange(transition, [], NOW + 5000);
    expect(timer.scheduledAt).toBe(NOW + 5000);
  });

  describe('stage:setlistSelect', () => {
    it('lists the read at the position the payload names', () => {
      const state = busyState();
      const cases: [Record<string, unknown>, VjSetlistReadPosition][] = [
        [{ setlistId: SETLIST_ID, index: null }, { kind: 'count' }],
        [{ setlistId: SETLIST_ID, index: null, isPlaying: true }, atIndex(0)],
        [{ setlistId: SETLIST_ID.toUpperCase(), index: 2 }, atIndex(2)],
        [{ setlistId: SETLIST_ID, index: 1, isPlaying: true }, atIndex(1)],
      ];
      for (const [payload, position] of cases) {
        const prepared = ruleSetlistSelect(state, payload, PREPARE_CONTEXT);
        expect(prepared.accepted?.lookups).toEqual([
          { kind: 'setlistItem', setlistId: SETLIST_ID, position },
        ]);
        expect(prepared.accepted?.nextState).toBe(state);
      }
      const stop = ruleSetlistSelect(
        state,
        { setlistId: null, index: null },
        PREPARE_CONTEXT,
      );
      expect(stop.accepted?.lookups).toEqual([]);
    });

    it('arms a set list with a null index: nothing on screen, Loop from the read', () => {
      const state = playingState(1);
      const result = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: null },
        readContext({ kind: 'count' }, setlistRead(null, { isLooping: true })),
      );
      expect(result.accepted?.isLookSwitch).toBe(false);
      expect(result.accepted?.overlayHideAfterMs).toBeUndefined();
      expect(result.accepted?.setlistClock).toEqual({ kind: 'clear' });
      const armed = acceptedState(result);
      expect(armed.activeSetlistId).toBe(SETLIST_ID);
      expect(armed.setlistIndex).toBeNull();
      expect(armed.setlistPlayback).toEqual(createVjSetlistPlayback(true));
      expect(armed.liveClipId).toBe(state.liveClipId);
      expect(armed.effects).toEqual(state.effects);
    });

    it('steps through a scene step by hand: recall, manual, clock cleared', () => {
      const state = busyState();
      const result = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: 1, ...COMMAND_FIELDS },
        readContext(atIndex(1), setlistRead(sceneStep(1))),
      );
      expect(result.accepted?.isLookSwitch).toBe(true);
      expect(result.accepted?.overlayHideAfterMs).toBeNull();
      expect(result.accepted?.setlistClock).toEqual({ kind: 'clear' });
      expect(result.accepted?.scheduledAt).toBeNull();
      const landed = landedState(result);
      expect(landed.activeSetlistId).toBe(SETLIST_ID);
      expect(landed.setlistIndex).toBe(1);
      expect(landed.liveClipId).toBe(SCENE_CLIP_ID);
      expect(landed.overlay.hideAt).toBeNull();
      expect(landed.effects.speed).toBe(1.5);
      expect(landed.shuffle.isOn).toBe(true);
      expect(landed.setlistPlayback).toEqual({
        ...createVjSetlistPlayback(false),
        itemId: itemIdAt(1),
      });
    });

    it('steps through a clip step by hand: live source only, any pack', () => {
      const state = busyState();
      const result = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: 2 },
        readContext(atIndex(2), setlistRead(clipStep(2))),
      );
      expect(result.accepted?.lookups).toEqual([
        { kind: 'setlistItem', setlistId: SETLIST_ID, position: atIndex(2) },
      ]);
      expect(result.accepted?.isLookSwitch).toBe(true);
      expect(result.accepted?.overlayHideAfterMs).toBeUndefined();
      const landed = landedState(result);
      expect(landed.liveClipId).toBe(STEP_CLIP_ID);
      expect(landed.activePackId).toBe(PACK_ID);
      expect(landed.overlay).toEqual(state.overlay);
      expect(landed.effects).toEqual(state.effects);
      expect(landed.mix).toEqual(state.mix);
      expect(landed.recentClipIds[0]).toBe(STEP_CLIP_ID);
      expect(landed.setlistIndex).toBe(2);
      expect(landed.setlistPlayback.status).toBe('manual');
      expect(landed.setlistPlayback.itemId).toBe(itemIdAt(2));
    });

    it('plays from a row: playing, shuffle off, clock started at full length once landed', () => {
      const state = busyState();
      const sceneResult = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: null, isPlaying: true },
        readContext(atIndex(0), setlistRead(sceneStep(0))),
      );
      expect(sceneResult.accepted?.setlistClock).toEqual({
        kind: 'start',
        durationMs: EIGHT_SECONDS_MS,
        remainingMs: EIGHT_SECONDS_MS,
      });
      expect(
        sceneResult.accepted?.nextState.setlistPlayback.stepEndsAt,
      ).toBeNull();
      const scene = landedState(sceneResult, NOW + 250);
      expect(scene.setlistIndex).toBe(0);
      expect(scene.liveClipId).toBe(SCENE_CLIP_ID);
      expect(scene.shuffle.isOn).toBe(false);
      expect(scene.setlistPlayback.itemId).toBe(itemIdAt(0));
      expectRunningClock(scene, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS, NOW + 250);

      const clip = landedState(
        ruleSetlistSelect(
          state,
          { setlistId: SETLIST_ID, index: 2, isPlaying: true },
          readContext(atIndex(2), setlistRead(clipStep(2))),
        ),
      );
      expect(clip.liveClipId).toBe(STEP_CLIP_ID);
      expect(clip.activePackId).toBe(PACK_ID);
      expectRunningClock(clip, SIXTEEN_BEATS_MS, SIXTEEN_BEATS_MS);
    });

    it('starts a fresh run from any status', () => {
      const paused = sequenceState(2, {
        status: 'paused',
        stepDurationMs: EIGHT_SECONDS_MS,
        pausedRemainingMs: 1200,
        isFlashConfirmed: true,
        isLooping: true,
      });
      const landed = landedState(
        ruleSetlistSelect(
          paused,
          { setlistId: SETLIST_ID, index: 0 },
          readContext(atIndex(0), setlistRead(sceneStep(0))),
        ),
      );
      expect(landed.setlistPlayback).toEqual({
        ...createVjSetlistPlayback(false),
        itemId: itemIdAt(0),
      });
    });

    it('refuses Play on a flashing step without confirmation and plays it with', () => {
      const state = busyState();
      const context = readContext(
        atIndex(0),
        setlistRead(sceneStep(0, flashingLook())),
      );
      const refused = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: 0, isPlaying: true },
        context,
      );
      expect(failureCode(refused)).toBe('vj_setlist_flash_unconfirmed');

      const confirmed = landedState(
        ruleSetlistSelect(
          state,
          {
            setlistId: SETLIST_ID,
            index: 0,
            isPlaying: true,
            isFlashConfirmed: true,
          },
          context,
        ),
      );
      expect(confirmed.setlistPlayback.isFlashConfirmed).toBe(true);
      expectRunningClock(confirmed, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS);

      const byHand = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: 0 },
        context,
      );
      expect(byHand.failure).toBeNull();
    });

    it('stops the sequence with a null set list: every playback field reset', () => {
      const result = ruleSetlistSelect(
        playingState(1),
        { setlistId: null, index: null, isPlaying: false },
        PREPARE_CONTEXT,
      );
      expect(result.accepted?.lookups).toEqual([]);
      const applied = ruleSetlistSelect(
        playingState(1),
        { setlistId: null, index: null },
        applyContext(EMPTY_VJ_LOOKUP_RESULTS),
      );
      expect(applied.accepted?.setlistClock).toEqual({ kind: 'clear' });
      expect(applied.accepted?.isLookSwitch).toBe(false);
      const stopped = landedState(applied);
      expect(stopped.activeSetlistId).toBeNull();
      expect(stopped.setlistIndex).toBeNull();
      expect(stopped.setlistPlayback).toEqual(createVjSetlistPlayback(false));
      expect(stopped.liveClipId).toBe(LIVE_CLIP_ID);
    });

    it('runs the field rules in the frame table order', () => {
      const state = busyState();
      const cases: [Record<string, unknown>, string][] = [
        [{ setlistId: 'list', index: 0 }, 'vj_setlist_not_found'],
        [{ setlistId: SETLIST_ID, index: -1 }, 'vj_setlist_index_invalid'],
        [{ setlistId: null, index: 0 }, 'vj_setlist_index_invalid'],
        [
          { setlistId: SETLIST_ID, index: 0, isPlaying: 'yes' },
          'vj_effect_flag_invalid',
        ],
        [
          { setlistId: SETLIST_ID, index: 0, isFlashConfirmed: 1 },
          'vj_effect_flag_invalid',
        ],
        [
          { setlistId: SETLIST_ID, index: 0, isPlaying: null },
          'vj_effect_flag_invalid',
        ],
        [{ setlistId: null, index: null, isPlaying: true }, 'vj_setlist_none'],
        [
          { setlistId: SETLIST_ID, index: 0, isImmediate: true },
          'vj_immediate_not_allowed',
        ],
        [
          { setlistId: SETLIST_ID, index: 0, isImmediate: 'now' },
          'vj_effect_flag_invalid',
        ],
      ];
      for (const [payload, code] of cases) {
        expect(
          failureCode(ruleSetlistSelect(state, payload, PREPARE_CONTEXT)),
        ).toBe(code);
      }
      for (const index of [1.5, '1', undefined, 100, 3_000_000_000]) {
        expect(
          failureCode(
            ruleSetlistSelect(
              state,
              { setlistId: SETLIST_ID, index },
              PREPARE_CONTEXT,
            ),
          ),
        ).toBe('vj_setlist_index_invalid');
      }
      const lastIndex = VJ_LIMITS.setlistItemsMax - 1;
      expect(
        ruleSetlistSelect(
          state,
          { setlistId: SETLIST_ID, index: lastIndex },
          PREPARE_CONTEXT,
        ).failure,
      ).toBeNull();
      expect(
        failureCode(
          ruleSetlistSelect(
            state,
            { setlistId: null, index: null, isPlaying: false },
            PREPARE_CONTEXT,
          ),
        ),
      ).toBeNull();
    });

    it('answers the read refusals: not found, empty, index invalid', () => {
      const state = busyState();
      expect(
        failureCode(
          ruleSetlistSelect(
            state,
            { setlistId: SETLIST_ID, index: 0 },
            readContext(atIndex(0), null),
          ),
        ),
      ).toBe('vj_setlist_not_found');
      expect(
        failureCode(
          ruleSetlistSelect(
            state,
            { setlistId: SETLIST_ID, index: null },
            applyContext(EMPTY_VJ_LOOKUP_RESULTS),
          ),
        ),
      ).toBe('vj_setlist_not_found');
      expect(
        failureCode(
          ruleSetlistSelect(
            state,
            { setlistId: SETLIST_ID, index: 0, isPlaying: true },
            readContext(atIndex(0), setlistRead(null, { itemIds: [] })),
          ),
        ),
      ).toBe('vj_setlist_empty');
      expect(
        failureCode(
          ruleSetlistSelect(
            state,
            { setlistId: SETLIST_ID, index: 3 },
            readContext(atIndex(3), setlistRead(null)),
          ),
        ),
      ).toBe('vj_setlist_index_invalid');
      const armedEmpty = ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: null },
        readContext({ kind: 'count' }, setlistRead(null, { itemIds: [] })),
      );
      expect(armedEmpty.failure).toBeNull();
    });
  });

  describe('stage:setlistSetPlaying', () => {
    it('runs the field rules, then vj_setlist_none', () => {
      const state = sequenceState(0);
      const cases: [Record<string, unknown>, string][] = [
        [{}, 'vj_effect_flag_invalid'],
        [{ isPlaying: 'true' }, 'vj_effect_flag_invalid'],
        [
          { isPlaying: true, isFlashConfirmed: 'yes' },
          'vj_effect_flag_invalid',
        ],
        [{ isPlaying: true, isImmediate: true }, 'vj_immediate_not_allowed'],
      ];
      for (const [payload, code] of cases) {
        expect(
          failureCode(ruleSetlistSetPlaying(state, payload, PREPARE_CONTEXT)),
        ).toBe(code);
      }
      const noSetlist = { ...busyState(), activeSetlistId: null };
      for (const context of [
        PREPARE_CONTEXT,
        applyContext(EMPTY_VJ_LOOKUP_RESULTS),
      ]) {
        expect(
          failureCode(
            ruleSetlistSetPlaying(noSetlist, { isPlaying: true }, context),
          ),
        ).toBe('vj_setlist_none');
      }
    });

    it('lists the read each status needs', () => {
      const cases: [VjStageState, boolean, VjSetlistReadPosition | null][] = [
        [playingState(1), false, null],
        [sequenceState(1, { status: 'manual' }), false, null],
        [playingState(1), true, null],
        [
          sequenceState(1, {
            status: 'paused',
            stepDurationMs: EIGHT_SECONDS_MS,
            pausedRemainingMs: 2000,
          }),
          true,
          null,
        ],
        [sequenceState(1), true, atIndex(1)],
        [sequenceState(null), true, atIndex(0)],
        [sequenceState(1, { status: 'takenOver' }), true, atIndex(2, true)],
        [sequenceState(2, { status: 'finished' }), true, atIndex(0)],
        [
          sequenceState(0, { status: 'needsFlashConsent', isLooping: true }),
          true,
          atIndex(1, true),
        ],
      ];
      for (const [state, isPlaying, position] of cases) {
        const prepared = ruleSetlistSetPlaying(
          state,
          { isPlaying, ...COMMAND_FIELDS },
          PREPARE_CONTEXT,
        );
        expect(prepared.accepted?.lookups).toEqual(
          position === null
            ? []
            : [{ kind: 'setlistItem', setlistId: SETLIST_ID, position }],
        );
      }
    });

    it('plays the current step in place from manual: no recall, clock at full length', () => {
      const state = {
        ...sequenceState(1),
        shuffle: { ...busyState().shuffle, isOn: true },
      };
      const result = ruleSetlistSetPlaying(
        state,
        { isPlaying: true },
        readContext(atIndex(1), setlistRead(sceneStep(1, flashingLook()))),
      );
      expect(result.accepted?.isLookSwitch).toBe(false);
      const landed = landedState(result, NOW + 40);
      expect(landed.liveClipId).toBe(LIVE_CLIP_ID);
      expect(landed.effects).toEqual(state.effects);
      expect(landed.setlistIndex).toBe(1);
      expect(landed.setlistPlayback.itemId).toBe(itemIdAt(1));
      expect(landed.shuffle.isOn).toBe(false);
      expectRunningClock(landed, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS, NOW + 40);
    });

    it('plays step 1 from manual with no index, with the flash check', () => {
      const state = sequenceState(null);
      const clip = ruleSetlistSetPlaying(
        state,
        { isPlaying: true },
        readContext(atIndex(0), setlistRead(clipStep(0))),
      );
      expect(clip.accepted?.isLookSwitch).toBe(true);
      const landed = landedState(clip);
      expect(landed.liveClipId).toBe(STEP_CLIP_ID);
      expect(landed.setlistIndex).toBe(0);
      expectRunningClock(landed, SIXTEEN_BEATS_MS, SIXTEEN_BEATS_MS);

      const flashing = ruleSetlistSetPlaying(
        state,
        { isPlaying: true },
        readContext(atIndex(0), setlistRead(sceneStep(0, flashingLook()))),
      );
      expect(failureCode(flashing)).toBe('vj_setlist_flash_unconfirmed');
    });

    it('pauses a running step with the time left and no clock', () => {
      const state = playingState(1, 3000);
      const result = ruleSetlistSetPlaying(
        state,
        { isPlaying: false },
        applyContext(EMPTY_VJ_LOOKUP_RESULTS),
      );
      expect(result.accepted?.isLookSwitch).toBe(false);
      expect(result.accepted?.setlistClock).toEqual({ kind: 'clear' });
      const landed = landedState(result);
      expect(landed.setlistPlayback).toEqual({
        ...state.setlistPlayback,
        status: 'paused',
        stepStartedAt: null,
        stepEndsAt: null,
        stepDurationMs: EIGHT_SECONDS_MS,
        pausedRemainingMs: 3000,
      });
      expect(landed.liveClipId).toBe(state.liveClipId);
    });

    it('accepts Pause outside playing and Play while playing as noops', () => {
      const statuses: Partial<VjSetlistPlayback>[] = [
        { status: 'manual' },
        {
          status: 'paused',
          stepDurationMs: EIGHT_SECONDS_MS,
          pausedRemainingMs: 1000,
        },
        { status: 'takenOver' },
        { status: 'finished' },
        { status: 'needsFlashConsent' },
      ];
      for (const playback of statuses) {
        const state = sequenceState(1, playback);
        const result = ruleSetlistSetPlaying(
          state,
          { isPlaying: false },
          applyContext(EMPTY_VJ_LOOKUP_RESULTS),
        );
        expect(result.accepted?.nextState).toBe(state);
        expect(result.accepted?.setlistClock).toEqual({ kind: 'keep' });
      }
      const playing = playingState(1);
      const again = ruleSetlistSetPlaying(
        playing,
        { isPlaying: true },
        applyContext(EMPTY_VJ_LOOKUP_RESULTS),
      );
      expect(again.accepted?.nextState).toBe(playing);
      expect(again.accepted?.setlistClock).toEqual({ kind: 'keep' });
      expect(landedState(again).setlistPlayback).toEqual(
        playing.setlistPlayback,
      );
    });

    it('resumes a paused step with the time it had left', () => {
      const state = sequenceState(1, {
        status: 'paused',
        stepDurationMs: EIGHT_SECONDS_MS,
        pausedRemainingMs: 2500,
      });
      const result = ruleSetlistSetPlaying(
        state,
        { isPlaying: true },
        applyContext(EMPTY_VJ_LOOKUP_RESULTS),
      );
      expect(result.accepted?.isLookSwitch).toBe(false);
      expect(result.accepted?.setlistClock).toEqual({
        kind: 'start',
        durationMs: EIGHT_SECONDS_MS,
        remainingMs: 2500,
      });
      const landed = landedState(result, NOW + 100);
      expect(landed.liveClipId).toBe(state.liveClipId);
      expect(landed.setlistIndex).toBe(1);
      expectRunningClock(landed, EIGHT_SECONDS_MS, 2500, NOW + 100);
    });

    it('resumes a taken over sequence on the next step, wrapping to step 1 at the end', () => {
      const middle = sequenceState(1, { status: 'takenOver' });
      const next = landedState(
        ruleSetlistSetPlaying(
          middle,
          { isPlaying: true },
          readContext(atIndex(2, true), setlistRead(clipStep(2))),
        ),
      );
      expect(next.setlistIndex).toBe(2);
      expect(next.liveClipId).toBe(STEP_CLIP_ID);
      expectRunningClock(next, SIXTEEN_BEATS_MS, SIXTEEN_BEATS_MS);

      const last = sequenceState(2, { status: 'takenOver' });
      const wrapped = landedState(
        ruleSetlistSetPlaying(
          last,
          { isPlaying: true },
          readContext(atIndex(3, true), setlistRead(sceneStep(0))),
        ),
      );
      expect(wrapped.setlistIndex).toBe(0);
      expect(wrapped.liveClipId).toBe(SCENE_CLIP_ID);
      expect(wrapped.setlistPlayback.itemId).toBe(itemIdAt(0));
      expectRunningClock(wrapped, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS);
    });

    it('plays a finished sequence again from step 1', () => {
      const state = sequenceState(2, { status: 'finished' });
      const landed = landedState(
        ruleSetlistSetPlaying(
          state,
          { isPlaying: true },
          readContext(atIndex(0), setlistRead(sceneStep(0))),
        ),
      );
      expect(landed.setlistIndex).toBe(0);
      expect(landed.liveClipId).toBe(SCENE_CLIP_ID);
      expectRunningClock(landed, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS);
    });

    it('plays the flashing step after a flash pause only with confirmation', () => {
      const state = sequenceState(0, { status: 'needsFlashConsent' });
      const context = readContext(
        atIndex(1),
        setlistRead(sceneStep(1, flashingLook())),
      );
      expect(
        failureCode(ruleSetlistSetPlaying(state, { isPlaying: true }, context)),
      ).toBe('vj_setlist_flash_unconfirmed');
      const landed = landedState(
        ruleSetlistSetPlaying(
          state,
          { isPlaying: true, isFlashConfirmed: true },
          context,
        ),
      );
      expect(landed.setlistIndex).toBe(1);
      expect(landed.transition.mode).toBe('dipWhite');
      expect(landed.setlistPlayback.isFlashConfirmed).toBe(true);
      expectRunningClock(landed, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS);
    });

    it('answers the read refusals for a step it has to read', () => {
      const state = sequenceState(1, { status: 'takenOver' });
      const position = atIndex(2, true);
      expect(
        failureCode(
          ruleSetlistSetPlaying(
            state,
            { isPlaying: true },
            readContext(position, null),
          ),
        ),
      ).toBe('vj_setlist_not_found');
      expect(
        failureCode(
          ruleSetlistSetPlaying(
            state,
            { isPlaying: true },
            readContext(position, setlistRead(null, { itemIds: [] })),
          ),
        ),
      ).toBe('vj_setlist_empty');
      expect(
        failureCode(
          ruleSetlistSetPlaying(
            sequenceState(1),
            { isPlaying: true },
            readContext(atIndex(1), setlistRead(null)),
          ),
        ),
      ).toBe('vj_setlist_index_invalid');
      expect(
        failureCode(
          ruleSetlistSetPlaying(
            state,
            { isPlaying: true },
            applyContext(EMPTY_VJ_LOOKUP_RESULTS),
          ),
        ),
      ).toBe('vj_setlist_not_found');
    });

    it('answers vj_stale_setlist with the state when the position moved', () => {
      const handed = readContext(atIndex(1), setlistRead(sceneStep(1)));
      const moved = sequenceState(2);
      const stale = ruleSetlistSetPlaying(moved, { isPlaying: true }, handed);
      expect(failureCode(stale)).toBe('vj_stale_setlist');
      expect(stale.failure?.state).toEqual(moved);

      const nowPlaying = playingState(1);
      const noReadNeeded = ruleSetlistSetPlaying(
        nowPlaying,
        { isPlaying: true },
        handed,
      );
      expect(failureCode(noReadNeeded)).toBe('vj_stale_setlist');
      expect(noReadNeeded.failure?.state).toEqual(nowPlaying);

      const stopped = { ...moved, activeSetlistId: null, setlistIndex: null };
      expect(
        failureCode(
          ruleSetlistSetPlaying(stopped, { isPlaying: true }, handed),
        ),
      ).toBe('vj_stale_setlist');

      const otherList = {
        ...sequenceState(1),
        activeSetlistId: OTHER_SETLIST_ID,
      };
      expect(
        failureCode(
          ruleSetlistSetPlaying(otherList, { isPlaying: true }, handed),
        ),
      ).toBe('vj_stale_setlist');
    });
  });

  describe('stage:setlistNext and stage:setlistPrevious', () => {
    it('refuses with no active set list and lists the read at the step position', () => {
      const noSetlist = busyState();
      for (const rule of [ruleSetlistNext, ruleSetlistPrevious]) {
        expect(
          failureCode(rule(noSetlist, COMMAND_FIELDS, PREPARE_CONTEXT)),
        ).toBe('vj_setlist_none');
        expect(
          failureCode(
            rule(
              noSetlist,
              { ...COMMAND_FIELDS, isImmediate: true },
              readContext(atIndex(0), setlistRead(sceneStep(0))),
            ),
          ),
        ).toBe('vj_immediate_not_allowed');
      }
      const cases: [
        typeof ruleSetlistNext,
        VjStageState,
        VjSetlistReadPosition,
      ][] = [
        [ruleSetlistNext, sequenceState(null), atIndex(0)],
        [ruleSetlistNext, sequenceState(1), atIndex(2)],
        [
          ruleSetlistNext,
          sequenceState(2, { isLooping: true }),
          atIndex(3, true),
        ],
        [ruleSetlistPrevious, sequenceState(2), atIndex(1)],
        [ruleSetlistPrevious, sequenceState(0), { kind: 'count' }],
        [ruleSetlistPrevious, sequenceState(null), { kind: 'count' }],
        [
          ruleSetlistPrevious,
          sequenceState(0, { isLooping: true }),
          { kind: 'last' },
        ],
        [
          ruleSetlistPrevious,
          sequenceState(null, { isLooping: true }),
          { kind: 'last' },
        ],
      ];
      for (const [rule, state, position] of cases) {
        expect(
          rule(state, COMMAND_FIELDS, PREPARE_CONTEXT).accepted?.lookups,
        ).toEqual([{ kind: 'setlistItem', setlistId: SETLIST_ID, position }]);
      }
    });

    it('keeps a playing run playing and restarts the clock on the new step', () => {
      const state = playingState(0);
      const next = ruleSetlistNext(
        state,
        COMMAND_FIELDS,
        readContext(atIndex(1), setlistRead(clipStep(1))),
      );
      expect(next.accepted?.isLookSwitch).toBe(true);
      const landedNext = landedState(next, NOW + 75);
      expect(landedNext.setlistIndex).toBe(1);
      expect(landedNext.liveClipId).toBe(STEP_CLIP_ID);
      expect(landedNext.setlistPlayback.itemId).toBe(itemIdAt(1));
      expectRunningClock(
        landedNext,
        SIXTEEN_BEATS_MS,
        SIXTEEN_BEATS_MS,
        NOW + 75,
      );

      const previous = landedState(
        ruleSetlistPrevious(
          playingState(2),
          COMMAND_FIELDS,
          readContext(atIndex(1), setlistRead(sceneStep(1))),
        ),
      );
      expect(previous.setlistIndex).toBe(1);
      expect(previous.liveClipId).toBe(SCENE_CLIP_ID);
      expectRunningClock(previous, EIGHT_SECONDS_MS, EIGHT_SECONDS_MS);
    });

    it('keeps a manual run manual with no clock', () => {
      const result = ruleSetlistNext(
        sequenceState(0),
        COMMAND_FIELDS,
        readContext(atIndex(1), setlistRead(sceneStep(1))),
      );
      expect(result.accepted?.setlistClock).toEqual({ kind: 'clear' });
      expect(result.accepted?.overlayHideAfterMs).toBeNull();
      const landed = landedState(result);
      expect(landed.setlistIndex).toBe(1);
      expect(landed.setlistPlayback.status).toBe('manual');
      expect(landed.setlistPlayback.stepStartedAt).toBeNull();
      expect(landed.setlistPlayback.stepEndsAt).toBeNull();
      expect(landed.liveClipId).toBe(SCENE_CLIP_ID);
    });

    it('lands paused with the new step whole from paused, taken over, finished and flash pause', () => {
      const statuses: Partial<VjSetlistPlayback>[] = [
        {
          status: 'paused',
          stepDurationMs: EIGHT_SECONDS_MS,
          pausedRemainingMs: 900,
        },
        { status: 'takenOver' },
        { status: 'finished' },
        { status: 'needsFlashConsent' },
      ];
      for (const playback of statuses) {
        const landed = landedState(
          ruleSetlistNext(
            sequenceState(0, playback),
            COMMAND_FIELDS,
            readContext(atIndex(1), setlistRead(clipStep(1))),
          ),
        );
        expect(landed.setlistIndex).toBe(1);
        expect(landed.liveClipId).toBe(STEP_CLIP_ID);
        expect(landed.setlistPlayback).toMatchObject({
          status: 'paused',
          itemId: itemIdAt(1),
          stepStartedAt: null,
          stepEndsAt: null,
          stepDurationMs: SIXTEEN_BEATS_MS,
          pausedRemainingMs: SIXTEEN_BEATS_MS,
        });
      }
    });

    it('wraps with Loop on: Next past the end to step 1, Previous from step 1 to the last', () => {
      const lastStep = sequenceState(2, { isLooping: true });
      const wrappedNext = landedState(
        ruleSetlistNext(
          lastStep,
          COMMAND_FIELDS,
          readContext(
            atIndex(3, true),
            setlistRead(sceneStep(0), { isLooping: true }),
          ),
        ),
      );
      expect(wrappedNext.setlistIndex).toBe(0);
      expect(wrappedNext.setlistPlayback.itemId).toBe(itemIdAt(0));
      expect(wrappedNext.setlistPlayback.isLooping).toBe(true);

      const firstStep = sequenceState(0, { isLooping: true });
      const wrappedPrevious = landedState(
        ruleSetlistPrevious(
          firstStep,
          COMMAND_FIELDS,
          readContext(
            { kind: 'last' },
            setlistRead(clipStep(2), { isLooping: true }),
          ),
        ),
      );
      expect(wrappedPrevious.setlistIndex).toBe(2);
      expect(wrappedPrevious.liveClipId).toBe(STEP_CLIP_ID);
    });

    it('answers vj_setlist_end and vj_setlist_start at the ends with Loop off', () => {
      expect(
        failureCode(
          ruleSetlistNext(
            sequenceState(2),
            COMMAND_FIELDS,
            readContext(atIndex(3), setlistRead(null)),
          ),
        ),
      ).toBe('vj_setlist_end');
      for (const index of [0, null]) {
        expect(
          failureCode(
            ruleSetlistPrevious(
              sequenceState(index),
              COMMAND_FIELDS,
              readContext({ kind: 'count' }, setlistRead(null)),
            ),
          ),
        ).toBe('vj_setlist_start');
        expect(
          failureCode(
            ruleSetlistPrevious(
              sequenceState(index),
              COMMAND_FIELDS,
              readContext(
                { kind: 'count' },
                setlistRead(null, { itemIds: [] }),
              ),
            ),
          ),
        ).toBe('vj_setlist_empty');
      }
      expect(
        failureCode(
          ruleSetlistNext(
            sequenceState(0),
            COMMAND_FIELDS,
            readContext(atIndex(1), setlistRead(null, { itemIds: [] })),
          ),
        ),
      ).toBe('vj_setlist_empty');
      expect(
        failureCode(
          ruleSetlistPrevious(
            sequenceState(2),
            COMMAND_FIELDS,
            readContext(atIndex(1), setlistRead(null)),
          ),
        ),
      ).toBe('vj_setlist_index_invalid');
    });

    it('refuses a flashing step nobody confirmed, from a playing or paused run', () => {
      expect(
        failureCode(
          ruleSetlistNext(
            playingState(0),
            COMMAND_FIELDS,
            readContext(atIndex(1), setlistRead(sceneStep(1, flashingLook()))),
          ),
        ),
      ).toBe('vj_setlist_flash_unconfirmed');
      expect(
        failureCode(
          ruleSetlistPrevious(
            sequenceState(2, { status: 'paused' }),
            { ...COMMAND_FIELDS, isFlashConfirmed: false },
            readContext(atIndex(1), setlistRead(sceneStep(1, flashingLook()))),
          ),
        ),
      ).toBe('vj_setlist_flash_unconfirmed');
    });

    it('lands a flashing step the tap or the stored run flag confirmed', () => {
      const confirmedByTap = ruleSetlistNext(
        playingState(0),
        { ...COMMAND_FIELDS, isFlashConfirmed: true },
        readContext(atIndex(1), setlistRead(sceneStep(1, flashingLook()))),
      );
      expect(confirmedByTap.failure).toBeNull();
      expect(confirmedByTap.accepted?.nextState.transition.mode).toBe(
        'dipWhite',
      );
      expect(landedState(confirmedByTap).setlistPlayback.isFlashConfirmed).toBe(
        false,
      );

      const confirmedByRun = ruleSetlistPrevious(
        sequenceState(2, { isFlashConfirmed: true }),
        COMMAND_FIELDS,
        readContext(atIndex(1), setlistRead(sceneStep(1, flashingLook()))),
      );
      expect(confirmedByRun.failure).toBeNull();
      expect(landedState(confirmedByRun).setlistIndex).toBe(1);
    });

    it('answers vj_effect_flag_invalid for an isFlashConfirmed that is not a boolean', () => {
      for (const rule of [ruleSetlistNext, ruleSetlistPrevious]) {
        for (const isFlashConfirmed of ['true', 1, null]) {
          const payload = { ...COMMAND_FIELDS, isFlashConfirmed };
          expect(
            failureCode(rule(sequenceState(1), payload, PREPARE_CONTEXT)),
          ).toBe('vj_effect_flag_invalid');
          expect(
            failureCode(
              rule(
                sequenceState(1),
                payload,
                readContext(atIndex(2), setlistRead(clipStep(2))),
              ),
            ),
          ).toBe('vj_effect_flag_invalid');
        }
      }
    });

    it('turns shuffle off when the step lands paused', () => {
      const base = sequenceState(0, { status: 'takenOver' });
      const state = { ...base, shuffle: { ...base.shuffle, isOn: true } };
      const landed = landedState(
        ruleSetlistNext(
          state,
          COMMAND_FIELDS,
          readContext(atIndex(1), setlistRead(clipStep(1))),
        ),
      );
      expect(landed.setlistPlayback.status).toBe('paused');
      expect(landed.shuffle.isOn).toBe(false);
    });

    it('answers vj_stale_setlist when another remote moved the sequence between prepare and apply', () => {
      const handed = readContext(atIndex(1), setlistRead(sceneStep(1)));
      const stepped = sequenceState(1);
      const stale = ruleSetlistNext(stepped, COMMAND_FIELDS, handed);
      expect(failureCode(stale)).toBe('vj_stale_setlist');
      expect(stale.failure?.state).toEqual(stepped);

      const switched = {
        ...sequenceState(0),
        activeSetlistId: OTHER_SETLIST_ID,
      };
      expect(
        failureCode(ruleSetlistNext(switched, COMMAND_FIELDS, handed)),
      ).toBe('vj_stale_setlist');

      const cleared = { ...busyState(), activeSetlistId: null };
      expect(
        failureCode(ruleSetlistNext(cleared, COMMAND_FIELDS, handed)),
      ).toBe('vj_stale_setlist');

      const loopTurnedOn = sequenceState(0, { isLooping: true });
      expect(
        failureCode(ruleSetlistPrevious(loopTurnedOn, COMMAND_FIELDS, handed)),
      ).toBe('vj_stale_setlist');
    });

    it('answers vj_setlist_not_found when the set list is gone', () => {
      expect(
        failureCode(
          ruleSetlistNext(
            sequenceState(0),
            COMMAND_FIELDS,
            readContext(atIndex(1), null),
          ),
        ),
      ).toBe('vj_setlist_not_found');
      expect(
        failureCode(
          ruleSetlistPrevious(
            sequenceState(2),
            COMMAND_FIELDS,
            applyContext(EMPTY_VJ_LOOKUP_RESULTS),
          ),
        ),
      ).toBe('vj_setlist_not_found');
    });
  });

  describe('stage:setlistSetLooping', () => {
    it('sets the Loop copy on the active set list and keeps the clock', () => {
      const state = playingState(1);
      const result = ruleSetlistSetLooping(
        state,
        { isLooping: true, ...COMMAND_FIELDS },
        PREPARE_CONTEXT,
      );
      expect(result.accepted?.lookups).toEqual([]);
      expect(result.accepted?.isLookSwitch).toBe(false);
      expect(result.accepted?.setlistClock).toEqual({ kind: 'keep' });
      const landed = landedState(result);
      expect(landed.setlistPlayback).toEqual({
        ...state.setlistPlayback,
        isLooping: true,
      });
      expect(landed.setlistIndex).toBe(1);
      expect(landed.liveClipId).toBe(state.liveClipId);
    });

    it('refuses a missing flag, an immediate change and no active set list', () => {
      const state = sequenceState(0);
      expect(
        failureCode(ruleSetlistSetLooping(state, {}, PREPARE_CONTEXT)),
      ).toBe('vj_effect_flag_invalid');
      expect(
        failureCode(
          ruleSetlistSetLooping(state, { isLooping: 'on' }, PREPARE_CONTEXT),
        ),
      ).toBe('vj_effect_flag_invalid');
      expect(
        failureCode(
          ruleSetlistSetLooping(
            state,
            { isLooping: true, isImmediate: true },
            PREPARE_CONTEXT,
          ),
        ),
      ).toBe('vj_immediate_not_allowed');
      expect(
        failureCode(
          ruleSetlistSetLooping(
            busyState(),
            { isLooping: true },
            PREPARE_CONTEXT,
          ),
        ),
      ).toBe('vj_setlist_none');
    });
  });
});
