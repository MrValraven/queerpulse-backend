import {
  createVjStageState,
  VJ_LIMITS,
  type VjMix,
  type VjScreenOverride,
  type VjStageState,
} from '../vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleContext,
} from './vj-rule-kit';
import {
  restoredVjMix,
  ruleGoClip,
  ruleGoGenerator,
  ruleSetMix,
  ruleSetPack,
  ruleSetScreenOverride,
  ruleSwapMix,
} from './vj-source-rules';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_PACK_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';
const SCREEN_ID = '77777777-7777-4777-8777-777777777777';
const OFFLINE_SCREEN_ID = '88888888-8888-4888-8888-888888888888';
const COMMAND_FIELDS = { clientId: STAGE_EPOCH, commandSequence: 1 };

function screenIdAt(position: number): string {
  return `00000000-0000-4000-8000-${String(position).padStart(12, '0')}`;
}

function baseState(): VjStageState {
  return createVjStageState(STAGE_EPOCH, NOW);
}

function lookupResults(fields: Partial<VjLookupResults>): VjLookupResults {
  return { ...EMPTY_VJ_LOOKUP_RESULTS, ...fields };
}

function contextOf(fields: Partial<VjRuleContext> = {}): VjRuleContext {
  return {
    now: NOW,
    lookups: null,
    connectedScreenIds: new Set([SCREEN_ID]),
    isLeadMicOn: false,
    ...fields,
  };
}

function acceptedState(result: VjCommandRuleResult): VjStageState {
  if (result.accepted === null) {
    throw new Error(`refused with ${result.failure.code}`);
  }
  return result.accepted.nextState;
}

function refusalCode(result: VjCommandRuleResult): string | null {
  return result.failure === null ? null : result.failure.code;
}

function clipOverride(clipId: string): VjScreenOverride {
  return { clipId, generatorId: null, generatorVariant: null };
}

describe('vj source rules', () => {
  it('empties the excluded list and hides the event card on a pack with no event', () => {
    const state: VjStageState = {
      ...baseState(),
      activePackId: PACK_ID,
      eventCard: { isVisible: true, kind: 'qr' },
      shuffle: { ...baseState().shuffle, excludedClipIds: [CLIP_ID] },
    };
    const lookups = lookupResults({
      packs: new Map([[SECOND_PACK_ID, { eventId: null }]]),
    });
    const result = ruleSetPack(
      state,
      { packId: SECOND_PACK_ID, ...COMMAND_FIELDS },
      contextOf({ lookups }),
    );
    const nextState = acceptedState(result);
    expect(nextState.activePackId).toBe(SECOND_PACK_ID);
    expect(nextState.clipSequence).toBe(state.clipSequence + 1);
    expect(nextState.shuffle.excludedClipIds).toEqual([]);
    expect(nextState.eventCard).toEqual({ isVisible: false, kind: 'qr' });
    expect(result.accepted?.lookups).toEqual([
      { kind: 'pack', packId: SECOND_PACK_ID },
    ]);

    const toNoPack = acceptedState(
      ruleSetPack(state, { packId: null, ...COMMAND_FIELDS }, contextOf()),
    );
    expect(toNoPack.activePackId).toBeNull();
    expect(toNoPack.eventCard.isVisible).toBe(false);
  });

  it('keeps the event card for a pack that links an event', () => {
    const state: VjStageState = {
      ...baseState(),
      activePackId: PACK_ID,
      eventCard: { isVisible: true, kind: 'nextEvent' },
    };
    const lookups = lookupResults({
      packs: new Map([[SECOND_PACK_ID, { eventId: EVENT_ID }]]),
    });
    const nextState = acceptedState(
      ruleSetPack(
        state,
        { packId: SECOND_PACK_ID.toUpperCase(), ...COMMAND_FIELDS },
        contextOf({ lookups }),
      ),
    );
    expect(nextState.activePackId).toBe(SECOND_PACK_ID);
    expect(nextState.eventCard).toEqual({ isVisible: true, kind: 'nextEvent' });
  });

  it('answers the same pack unchanged and refuses an unknown or malformed pack', () => {
    const state: VjStageState = { ...baseState(), activePackId: PACK_ID };
    const known = lookupResults({
      packs: new Map([[PACK_ID, { eventId: null }]]),
    });
    expect(
      acceptedState(
        ruleSetPack(
          state,
          { packId: PACK_ID, ...COMMAND_FIELDS },
          contextOf({ lookups: known }),
        ),
      ),
    ).toBe(state);
    const unknown = lookupResults({ packs: new Map([[PACK_ID, null]]) });
    expect(
      refusalCode(
        ruleSetPack(
          state,
          { packId: PACK_ID, ...COMMAND_FIELDS },
          contextOf({ lookups: unknown }),
        ),
      ),
    ).toBe('vj_pack_not_found');
    expect(
      refusalCode(
        ruleSetPack(state, { packId: 'x', ...COMMAND_FIELDS }, contextOf()),
      ),
    ).toBe('vj_pack_not_found');
  });

  it('clears the generator when a clip goes live and puts the clip first in history', () => {
    const state: VjStageState = {
      ...baseState(),
      liveGeneratorId: 'prideFlagWave',
      liveGeneratorVariant: 'trans',
      recentClipIds: [SECOND_CLIP_ID, CLIP_ID],
    };
    const nextState = acceptedState(
      ruleGoClip(state, { clipId: CLIP_ID, ...COMMAND_FIELDS }, contextOf()),
    );
    expect(nextState.liveClipId).toBe(CLIP_ID);
    expect(nextState.liveGeneratorId).toBeNull();
    expect(nextState.liveGeneratorVariant).toBeNull();
    expect(nextState.recentClipIds).toEqual([CLIP_ID, SECOND_CLIP_ID]);
    expect(nextState.clipSequence).toBe(state.clipSequence + 1);

    const black = acceptedState(
      ruleGoClip(nextState, { clipId: null, ...COMMAND_FIELDS }, contextOf()),
    );
    expect(black.liveClipId).toBeNull();
    expect(black.recentClipIds).toEqual([CLIP_ID, SECOND_CLIP_ID]);
  });

  it('goes to black for a null generator and bumps the sequence on a repeat', () => {
    const state: VjStageState = { ...baseState(), liveClipId: CLIP_ID };
    const pride = acceptedState(
      ruleGoGenerator(state, {
        generatorId: 'prideFlagWave',
        ...COMMAND_FIELDS,
      }),
    );
    expect(pride.liveClipId).toBeNull();
    expect(pride.liveGeneratorId).toBe('prideFlagWave');
    expect(pride.liveGeneratorVariant).toBe('rainbow');
    const repeat = acceptedState(
      ruleGoGenerator(pride, {
        generatorId: 'prideFlagWave',
        variant: 'rainbow',
        ...COMMAND_FIELDS,
      }),
    );
    expect(repeat.clipSequence).toBe(pride.clipSequence + 1);
    const black = acceptedState(
      ruleGoGenerator(repeat, { generatorId: null, ...COMMAND_FIELDS }),
    );
    expect(black.liveClipId).toBeNull();
    expect(black.liveGeneratorId).toBeNull();
    expect(black.liveGeneratorVariant).toBeNull();
    expect(black.clipSequence).toBe(repeat.clipSequence + 1);
    expect(
      refusalCode(
        ruleGoGenerator(state, { generatorId: 'lava', ...COMMAND_FIELDS }),
      ),
    ).toBe('vj_generator_invalid');
  });

  it('refuses a variant for a generator without variants', () => {
    const state = baseState();
    for (const payload of [
      { generatorId: 'plasma', variant: 'trans' },
      { generatorId: 'prideFlagWave', variant: null },
      { generatorId: 'prideFlagWave', variant: 'unknownFlag' },
      { generatorId: null, variant: 'trans' },
    ]) {
      expect(
        refusalCode(ruleGoGenerator(state, { ...payload, ...COMMAND_FIELDS })),
      ).toBe('vj_generator_variant_invalid');
    }
    expect(
      acceptedState(
        ruleGoGenerator(state, {
          generatorId: 'plasma',
          variant: null,
          ...COMMAND_FIELDS,
        }),
      ).liveGeneratorVariant,
    ).toBeNull();
  });

  it('zeroes the crossfader when the mix clip is cleared', () => {
    const state: VjStageState = {
      ...baseState(),
      mix: { clipId: CLIP_ID, amount: 0.6, blendMode: 'screen' },
    };
    const cleared = acceptedState(
      ruleSetMix(
        state,
        { clipId: null, amount: 0.4, ...COMMAND_FIELDS },
        contextOf(),
      ),
    );
    expect(cleared.mix).toEqual({
      clipId: null,
      amount: 0,
      blendMode: 'screen',
    });
    const moved = acceptedState(
      ruleSetMix(state, { amount: 0.333, ...COMMAND_FIELDS }, contextOf()),
    );
    expect(moved.mix).toEqual({
      clipId: CLIP_ID,
      amount: 0.33,
      blendMode: 'screen',
    });
  });

  it('checks a setMix patch in the contract order', () => {
    const state = baseState();
    expect(
      refusalCode(ruleSetMix(state, { ...COMMAND_FIELDS }, contextOf())),
    ).toBe('vj_patch_empty');
    expect(
      refusalCode(
        ruleSetMix(
          state,
          { clipId: 'x', amount: 2, ...COMMAND_FIELDS },
          contextOf(),
        ),
      ),
    ).toBe('vj_clip_not_found');
    expect(
      refusalCode(
        ruleSetMix(
          state,
          { amount: 1.005, blendMode: 'dodge', ...COMMAND_FIELDS },
          contextOf(),
        ),
      ),
    ).toBe('vj_mix_amount_invalid');
    expect(
      refusalCode(
        ruleSetMix(
          state,
          { blendMode: 'dodge', ...COMMAND_FIELDS },
          contextOf(),
        ),
      ),
    ).toBe('vj_blend_mode_invalid');
    expect(
      refusalCode(
        ruleSetMix(
          state,
          { amount: 0.5, isImmediate: true, ...COMMAND_FIELDS },
          contextOf(),
        ),
      ),
    ).toBe('vj_immediate_not_allowed');
  });

  it('refuses a swap with no mix clip', () => {
    expect(refusalCode(ruleSwapMix(baseState(), { ...COMMAND_FIELDS }))).toBe(
      'vj_mix_empty',
    );
  });

  it('swaps the mix clip live and keeps the blend mode', () => {
    const state: VjStageState = {
      ...baseState(),
      liveGeneratorId: 'plasma',
      mix: { clipId: CLIP_ID, amount: 0.8, blendMode: 'add' },
    };
    const nextState = acceptedState(ruleSwapMix(state, { ...COMMAND_FIELDS }));
    expect(nextState.liveClipId).toBe(CLIP_ID);
    expect(nextState.liveGeneratorId).toBeNull();
    expect(nextState.recentClipIds).toEqual([CLIP_ID]);
    expect(nextState.clipSequence).toBe(state.clipSequence + 1);
    expect(nextState.mix).toEqual({
      clipId: null,
      amount: 0,
      blendMode: 'add',
    });
  });

  it('refuses an override for a screen that is offline', () => {
    for (const screenId of [OFFLINE_SCREEN_ID, 'screen-1', null]) {
      expect(
        refusalCode(
          ruleSetScreenOverride(
            baseState(),
            { screenId, override: clipOverride(CLIP_ID), ...COMMAND_FIELDS },
            contextOf(),
          ),
        ),
      ).toBe('vj_screen_not_attached');
    }
  });

  it('refuses an override with both or neither source', () => {
    for (const override of [
      { clipId: CLIP_ID, generatorId: 'plasma', generatorVariant: null },
      { clipId: null, generatorId: null, generatorVariant: null },
      { clipId: CLIP_ID, generatorId: null },
      {
        clipId: CLIP_ID,
        generatorId: null,
        generatorVariant: null,
        extra: true,
      },
      'plasma',
    ]) {
      expect(
        refusalCode(
          ruleSetScreenOverride(
            baseState(),
            { screenId: SCREEN_ID, override, ...COMMAND_FIELDS },
            contextOf(),
          ),
        ),
      ).toBe('vj_override_invalid');
    }
    const generatorOverride = (
      generatorId: unknown,
      generatorVariant: unknown,
    ) =>
      refusalCode(
        ruleSetScreenOverride(
          baseState(),
          {
            screenId: SCREEN_ID,
            override: { clipId: null, generatorId, generatorVariant },
            ...COMMAND_FIELDS,
          },
          contextOf(),
        ),
      );
    expect(generatorOverride('lava', null)).toBe('vj_generator_invalid');
    expect(generatorOverride('plasma', 'trans')).toBe(
      'vj_generator_variant_invalid',
    );
    expect(generatorOverride('prideFlagWave', null)).toBe(
      'vj_generator_variant_invalid',
    );
    expect(generatorOverride('prideFlagWave', 'trans')).toBeNull();
  });

  it('refuses a seventeenth override', () => {
    const screenOverrides: Record<string, VjScreenOverride> = {};
    for (
      let position = 0;
      position < VJ_LIMITS.screenOverridesMax;
      position += 1
    ) {
      screenOverrides[screenIdAt(position)] = clipOverride(CLIP_ID);
    }
    const state: VjStageState = { ...baseState(), screenOverrides };
    expect(
      refusalCode(
        ruleSetScreenOverride(
          state,
          {
            screenId: SCREEN_ID,
            override: clipOverride(SECOND_CLIP_ID),
            ...COMMAND_FIELDS,
          },
          contextOf(),
        ),
      ),
    ).toBe('vj_overrides_too_many');
    const replacingScreenId = screenIdAt(0);
    const replaced = acceptedState(
      ruleSetScreenOverride(
        state,
        {
          screenId: replacingScreenId,
          override: clipOverride(SECOND_CLIP_ID),
          ...COMMAND_FIELDS,
        },
        contextOf({ connectedScreenIds: new Set([replacingScreenId]) }),
      ),
    );
    expect(replaced.screenOverrides[replacingScreenId]).toEqual(
      clipOverride(SECOND_CLIP_ID),
    );
  });

  it('removes an override with null', () => {
    const state: VjStageState = {
      ...baseState(),
      screenOverrides: { [SCREEN_ID]: clipOverride(CLIP_ID) },
    };
    const nextState = acceptedState(
      ruleSetScreenOverride(
        state,
        {
          screenId: SCREEN_ID.toUpperCase(),
          override: null,
          ...COMMAND_FIELDS,
        },
        contextOf(),
      ),
    );
    expect(nextState.screenOverrides).toEqual({});
  });

  it('lists the clip lookup and refuses an unknown clip only when lookups are given', () => {
    const state = baseState();
    const goClip = ruleGoClip(
      state,
      { clipId: CLIP_ID, ...COMMAND_FIELDS },
      contextOf(),
    );
    expect(goClip.accepted?.lookups).toEqual([
      { kind: 'clip', clipId: CLIP_ID },
    ]);
    const setMix = ruleSetMix(
      state,
      { clipId: CLIP_ID, ...COMMAND_FIELDS },
      contextOf(),
    );
    expect(setMix.accepted?.lookups).toEqual([
      { kind: 'clip', clipId: CLIP_ID },
    ]);
    const override = ruleSetScreenOverride(
      state,
      {
        screenId: SCREEN_ID,
        override: clipOverride(CLIP_ID),
        ...COMMAND_FIELDS,
      },
      contextOf(),
    );
    expect(override.accepted?.lookups).toEqual([
      { kind: 'clip', clipId: CLIP_ID },
    ]);
    expect(
      ruleGoClip(state, { clipId: null, ...COMMAND_FIELDS }, contextOf())
        .accepted?.lookups,
    ).toEqual([]);

    const unknownClip = contextOf({ lookups: EMPTY_VJ_LOOKUP_RESULTS });
    expect(
      refusalCode(
        ruleGoClip(state, { clipId: CLIP_ID, ...COMMAND_FIELDS }, unknownClip),
      ),
    ).toBe('vj_clip_not_found');
    expect(
      refusalCode(
        ruleSetMix(state, { clipId: CLIP_ID, ...COMMAND_FIELDS }, unknownClip),
      ),
    ).toBe('vj_clip_not_found');
    expect(
      refusalCode(
        ruleSetScreenOverride(
          state,
          {
            screenId: SCREEN_ID,
            override: clipOverride(CLIP_ID),
            ...COMMAND_FIELDS,
          },
          unknownClip,
        ),
      ),
    ).toBe('vj_clip_not_found');

    const knownClip = contextOf({
      lookups: lookupResults({ existingClipIds: new Set([CLIP_ID]) }),
    });
    expect(
      acceptedState(
        ruleGoClip(state, { clipId: CLIP_ID, ...COMMAND_FIELDS }, knownClip),
      ).liveClipId,
    ).toBe(CLIP_ID);
  });

  it('refuses isImmediate on every source command', () => {
    const state: VjStageState = {
      ...baseState(),
      mix: { clipId: CLIP_ID, amount: 0.5, blendMode: 'normal' },
    };
    const immediate = { isImmediate: true, ...COMMAND_FIELDS };
    const results = [
      ruleSetPack(state, { packId: PACK_ID, ...immediate }, contextOf()),
      ruleGoClip(state, { clipId: CLIP_ID, ...immediate }, contextOf()),
      ruleGoGenerator(state, { generatorId: 'plasma', ...immediate }),
      ruleSwapMix(state, { ...immediate }),
      ruleSetScreenOverride(
        state,
        { screenId: SCREEN_ID, override: null, ...immediate },
        contextOf(),
      ),
    ];
    for (const result of results) {
      expect(refusalCode(result)).toBe('vj_immediate_not_allowed');
    }
  });

  it('restores a mix leniently and drops a clip the reads did not find', () => {
    const defaults: VjMix = { clipId: null, amount: 0, blendMode: 'normal' };
    const isKnown = (clipId: string) => clipId === CLIP_ID;
    expect(
      restoredVjMix(
        { clipId: CLIP_ID.toUpperCase(), amount: 0.456, blendMode: 'multiply' },
        defaults,
        isKnown,
      ),
    ).toEqual({ clipId: CLIP_ID, amount: 0.46, blendMode: 'multiply' });
    expect(
      restoredVjMix(
        { clipId: SECOND_CLIP_ID, amount: 0.5, blendMode: 'add' },
        defaults,
        isKnown,
      ),
    ).toEqual({ clipId: null, amount: 0, blendMode: 'add' });
    expect(
      restoredVjMix(
        { clipId: CLIP_ID, amount: 'loud', blendMode: 'dodge' },
        defaults,
        isKnown,
      ),
    ).toEqual({ clipId: CLIP_ID, amount: 0, blendMode: 'normal' });
    expect(restoredVjMix('mix', defaults, isKnown)).toEqual(defaults);
  });
});
