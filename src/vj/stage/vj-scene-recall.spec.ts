import {
  createVjStageState,
  VJ_LIMITS,
  type VjSceneLook,
  type VjStageState,
} from '../vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  vjSetlistItemKey,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleContext,
  type VjSetlistItemRead,
} from './vj-rule-kit';
import {
  recallVjScene,
  ruleRecallScene,
  ruleSetlistNext,
  ruleSetlistPrevious,
  ruleSetlistSelect,
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

function setlistRead(
  setlistId: string,
  index: number | null,
  itemCount: number,
  look: VjSceneLook | null,
): VjSetlistItemRead {
  return {
    setlistId,
    index,
    itemCount,
    sceneId: look === null ? null : SCENE_ID,
    look,
  };
}

function setlistLookups(
  entries: [string, number | null, VjSetlistItemRead | null][],
): VjLookupResults {
  return lookupsWith({
    setlistItems: new Map(
      entries.map(([setlistId, index, read]) => [
        vjSetlistItemKey(setlistId, index),
        read,
      ]),
    ),
  });
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

  it('arms a set list with a null index and recalls with a number', () => {
    const state = busyState();
    const armedPayload = { setlistId: SETLIST_ID, index: null };
    const prepared = ruleSetlistSelect(state, armedPayload, PREPARE_CONTEXT);
    expect(prepared.accepted?.lookups).toEqual([
      { kind: 'setlistItem', setlistId: SETLIST_ID, index: null },
    ]);
    expect(prepared.accepted?.isLookSwitch).toBe(false);

    const armed = ruleSetlistSelect(
      state,
      armedPayload,
      applyContext(
        setlistLookups([
          [SETLIST_ID, null, setlistRead(SETLIST_ID, null, 3, null)],
        ]),
      ),
    );
    expect(armed.accepted?.isLookSwitch).toBe(false);
    expect(armed.accepted?.overlayHideAfterMs).toBeUndefined();
    const armedState = acceptedState(armed);
    expect(armedState.activeSetlistId).toBe(SETLIST_ID);
    expect(armedState.setlistIndex).toBeNull();
    expect(armedState.effects).toEqual(state.effects);

    const look = sceneLook({ kind: 'clip', clipId: SCENE_CLIP_ID });
    const recalled = acceptedState(
      ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID.toUpperCase(), index: 1 },
        applyContext(
          setlistLookups([
            [SETLIST_ID, 1, setlistRead(SETLIST_ID, 1, 3, look)],
          ]),
        ),
      ),
    );
    expect(recalled.activeSetlistId).toBe(SETLIST_ID);
    expect(recalled.setlistIndex).toBe(1);
    expect(recalled.liveClipId).toBe(SCENE_CLIP_ID);
    expect(recalled.overlay.hideAt).toBeNull();

    const cleared = acceptedState(
      ruleSetlistSelect(
        { ...state, activeSetlistId: SETLIST_ID, setlistIndex: 2 },
        { setlistId: null, index: null },
        PREPARE_CONTEXT,
      ),
    );
    expect(cleared.activeSetlistId).toBeNull();
    expect(cleared.setlistIndex).toBeNull();
  });

  it('refuses an index with no set list and an index past the end', () => {
    const state = busyState();
    expect(
      failureCode(
        ruleSetlistSelect(
          state,
          { setlistId: 'list', index: 0 },
          PREPARE_CONTEXT,
        ),
      ),
    ).toBe('vj_setlist_not_found');
    expect(
      failureCode(
        ruleSetlistSelect(
          state,
          { setlistId: null, index: 0 },
          PREPARE_CONTEXT,
        ),
      ),
    ).toBe('vj_setlist_index_invalid');
    for (const index of [-1, 1.5, '1', undefined, 100, 3_000_000_000]) {
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
    const pastEnd = ruleSetlistSelect(
      state,
      { setlistId: SETLIST_ID, index: 3 },
      applyContext(
        setlistLookups([[SETLIST_ID, 3, setlistRead(SETLIST_ID, 3, 3, null)]]),
      ),
    );
    expect(failureCode(pastEnd)).toBe('vj_setlist_index_invalid');

    const gone = ruleSetlistSelect(
      state,
      { setlistId: SETLIST_ID, index: 0 },
      applyContext(setlistLookups([[SETLIST_ID, 0, null]])),
    );
    expect(failureCode(gone)).toBe('vj_setlist_not_found');
  });

  it('answers vj_setlist_empty for an index on an empty set list', () => {
    const result = ruleSetlistSelect(
      busyState(),
      { setlistId: SETLIST_ID, index: 0 },
      applyContext(
        setlistLookups([[SETLIST_ID, 0, setlistRead(SETLIST_ID, 0, 0, null)]]),
      ),
    );
    expect(failureCode(result)).toBe('vj_setlist_empty');
  });

  it('steps next from an armed set list to item 0', () => {
    const state = {
      ...busyState(),
      activeSetlistId: SETLIST_ID,
      setlistIndex: null,
    };
    const prepared = ruleSetlistNext(state, COMMAND_FIELDS, PREPARE_CONTEXT);
    expect(prepared.accepted?.lookups).toEqual([
      { kind: 'setlistItem', setlistId: SETLIST_ID, index: 0 },
    ]);

    const look = sceneLook(null);
    const result = ruleSetlistNext(
      state,
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([[SETLIST_ID, 0, setlistRead(SETLIST_ID, 0, 2, look)]]),
      ),
    );
    const nextState = acceptedState(result);
    expect(nextState.setlistIndex).toBe(0);
    expect(nextState.activeSetlistId).toBe(SETLIST_ID);
    expect(nextState.effects.speed).toBe(2);

    const previous = ruleSetlistPrevious(
      { ...state, setlistIndex: 1 },
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([[SETLIST_ID, 0, setlistRead(SETLIST_ID, 0, 2, look)]]),
      ),
    );
    expect(acceptedState(previous).setlistIndex).toBe(0);
  });

  it('answers vj_setlist_end past the last item and vj_setlist_start at the first', () => {
    const state = {
      ...busyState(),
      activeSetlistId: SETLIST_ID,
      setlistIndex: 1,
    };
    const pastEnd = ruleSetlistNext(
      state,
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([[SETLIST_ID, 2, setlistRead(SETLIST_ID, 2, 2, null)]]),
      ),
    );
    expect(failureCode(pastEnd)).toBe('vj_setlist_end');

    const empty = ruleSetlistNext(
      state,
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([[SETLIST_ID, 2, setlistRead(SETLIST_ID, 2, 0, null)]]),
      ),
    );
    expect(failureCode(empty)).toBe('vj_setlist_empty');

    const atStart = ruleSetlistPrevious(
      { ...state, setlistIndex: 0 },
      COMMAND_FIELDS,
      PREPARE_CONTEXT,
    );
    expect(failureCode(atStart)).toBe('vj_setlist_start');

    const noSetlist = { ...state, activeSetlistId: null, setlistIndex: null };
    expect(
      failureCode(ruleSetlistNext(noSetlist, COMMAND_FIELDS, PREPARE_CONTEXT)),
    ).toBe('vj_setlist_none');
    expect(
      failureCode(
        ruleSetlistPrevious(noSetlist, COMMAND_FIELDS, PREPARE_CONTEXT),
      ),
    ).toBe('vj_setlist_none');
  });

  it('accepts the last index a set list can hold and refuses the next one before any read', () => {
    const state = busyState();
    const lastIndex = VJ_LIMITS.setlistItemsMax - 1;
    const prepared = ruleSetlistSelect(
      state,
      { setlistId: SETLIST_ID, index: lastIndex },
      PREPARE_CONTEXT,
    );
    expect(prepared.failure).toBeNull();
    expect(prepared.accepted?.lookups).toEqual([
      { kind: 'setlistItem', setlistId: SETLIST_ID, index: lastIndex },
    ]);
    const overMax = ruleSetlistSelect(
      state,
      { setlistId: SETLIST_ID, index: VJ_LIMITS.setlistItemsMax },
      PREPARE_CONTEXT,
    );
    expect(failureCode(overMax)).toBe('vj_setlist_index_invalid');
    expect(overMax.accepted).toBeNull();
  });

  it('answers vj_setlist_empty for previous on an armed empty set list and vj_setlist_start when it has items', () => {
    const armedState = {
      ...busyState(),
      activeSetlistId: SETLIST_ID,
      setlistIndex: null,
    };
    const prepared = ruleSetlistPrevious(
      armedState,
      COMMAND_FIELDS,
      PREPARE_CONTEXT,
    );
    expect(prepared.failure).toBeNull();
    expect(prepared.accepted?.lookups).toEqual([
      { kind: 'setlistItem', setlistId: SETLIST_ID, index: null },
    ]);

    const empty = ruleSetlistPrevious(
      armedState,
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([
          [SETLIST_ID, null, setlistRead(SETLIST_ID, null, 0, null)],
        ]),
      ),
    );
    expect(failureCode(empty)).toBe('vj_setlist_empty');

    const withItems = ruleSetlistPrevious(
      armedState,
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([
          [SETLIST_ID, null, setlistRead(SETLIST_ID, null, 3, null)],
        ]),
      ),
    );
    expect(failureCode(withItems)).toBe('vj_setlist_start');

    const gone = ruleSetlistPrevious(
      armedState,
      COMMAND_FIELDS,
      applyContext(setlistLookups([[SETLIST_ID, null, null]])),
    );
    expect(failureCode(gone)).toBe('vj_setlist_not_found');

    const stepped = ruleSetlistPrevious(
      { ...armedState, setlistIndex: 0 },
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([
          [SETLIST_ID, null, setlistRead(SETLIST_ID, null, 3, null)],
        ]),
      ),
    );
    expect(failureCode(stepped)).toBe('vj_stale_setlist');
  });

  it('answers vj_stale_setlist when another remote stepped between prepare and apply', () => {
    const preparedState = {
      ...busyState(),
      activeSetlistId: SETLIST_ID,
      setlistIndex: 0,
    };
    const handed = setlistLookups([
      [SETLIST_ID, 1, setlistRead(SETLIST_ID, 1, 4, sceneLook(null))],
    ]);
    const steppedState = { ...preparedState, setlistIndex: 1 };
    const stale = ruleSetlistNext(
      steppedState,
      COMMAND_FIELDS,
      applyContext(handed),
    );
    expect(failureCode(stale)).toBe('vj_stale_setlist');
    expect(stale.failure?.state).toEqual(steppedState);

    const switchedState = {
      ...preparedState,
      activeSetlistId: OTHER_SETLIST_ID,
    };
    expect(
      failureCode(
        ruleSetlistNext(switchedState, COMMAND_FIELDS, applyContext(handed)),
      ),
    ).toBe('vj_stale_setlist');

    const clearedState = {
      ...preparedState,
      activeSetlistId: null,
      setlistIndex: null,
    };
    expect(
      failureCode(
        ruleSetlistNext(clearedState, COMMAND_FIELDS, applyContext(handed)),
      ),
    ).toBe('vj_stale_setlist');

    const backToStart = ruleSetlistPrevious(
      { ...preparedState, setlistIndex: 0 },
      COMMAND_FIELDS,
      applyContext(
        setlistLookups([
          [SETLIST_ID, 0, setlistRead(SETLIST_ID, 0, 4, sceneLook(null))],
        ]),
      ),
    );
    expect(failureCode(backToStart)).toBe('vj_stale_setlist');
  });

  it('answers vj_setlist_not_found when the set list is gone', () => {
    const state = {
      ...busyState(),
      activeSetlistId: SETLIST_ID,
      setlistIndex: 0,
    };
    const next = ruleSetlistNext(
      state,
      COMMAND_FIELDS,
      applyContext(setlistLookups([[SETLIST_ID, 1, null]])),
    );
    expect(failureCode(next)).toBe('vj_setlist_not_found');

    const previous = ruleSetlistPrevious(
      { ...state, setlistIndex: 2 },
      COMMAND_FIELDS,
      applyContext(setlistLookups([[SETLIST_ID, 1, null]])),
    );
    expect(failureCode(previous)).toBe('vj_setlist_not_found');
  });

  it('marks every recall as a look switch', () => {
    const look = sceneLook({ kind: 'clip', clipId: SCENE_CLIP_ID });
    const state = {
      ...busyState(),
      activeSetlistId: SETLIST_ID,
      setlistIndex: 1,
    };
    const results = [
      ruleRecallScene(
        state,
        { sceneId: SCENE_ID, ...COMMAND_FIELDS },
        applyContext(lookupsWith({ scenes: new Map([[SCENE_ID, look]]) })),
      ),
      ruleSetlistSelect(
        state,
        { setlistId: SETLIST_ID, index: 0, ...COMMAND_FIELDS },
        applyContext(
          setlistLookups([
            [SETLIST_ID, 0, setlistRead(SETLIST_ID, 0, 3, look)],
          ]),
        ),
      ),
      ruleSetlistNext(
        state,
        COMMAND_FIELDS,
        applyContext(
          setlistLookups([
            [SETLIST_ID, 2, setlistRead(SETLIST_ID, 2, 3, look)],
          ]),
        ),
      ),
      ruleSetlistPrevious(
        state,
        COMMAND_FIELDS,
        applyContext(
          setlistLookups([
            [SETLIST_ID, 0, setlistRead(SETLIST_ID, 0, 3, look)],
          ]),
        ),
      ),
    ];
    for (const result of results) {
      expect(result.failure).toBeNull();
      expect(result.accepted?.isLookSwitch).toBe(true);
      expect(result.accepted?.overlayHideAfterMs).toBeNull();
      expect(result.accepted?.isImmediate).toBe(false);
      expect(result.accepted?.nextState.liveClipId).toBe(SCENE_CLIP_ID);
    }
  });
});
