import {
  createVjStageState,
  VJ_EFFECT_IDS,
  type VjEffectSettings,
  type VjStageState,
} from '../vj.contract';
import {
  restoredVjEffects,
  ruleSetEffects,
  ruleSetStrobe,
} from './vj-effects-rules';
import type { VjCommandRuleResult, VjRuleContext } from './vj-rule-kit';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

const CONTEXT: VjRuleContext = {
  now: NOW,
  lookups: null,
  connectedScreenIds: new Set<string>(),
  isLeadMicOn: false,
};

function stageWithSettings(settings: VjEffectSettings): VjStageState {
  const state = createVjStageState(STAGE_EPOCH, NOW);
  return { ...state, effects: { ...state.effects, settings } };
}

function failureCodeOf(result: VjCommandRuleResult): string | null {
  return result.failure === null ? null : result.failure.code;
}

function acceptedStateOf(result: VjCommandRuleResult): VjStageState {
  if (result.accepted === null) {
    throw new Error(`refused with ${result.failure.code}`);
  }
  return result.accepted.nextState;
}

describe('vj effects rules', () => {
  const state = createVjStageState(STAGE_EPOCH, NOW);

  it('checks a setEffects patch in the contract order', () => {
    expect(
      failureCodeOf(
        ruleSetEffects(
          state,
          { speed: 3, isBlackout: 'yes', settings: 'all' },
          CONTEXT,
        ),
      ),
    ).toBe('vj_speed_invalid');
    expect(
      failureCodeOf(
        ruleSetEffects(
          state,
          { speed: 2, isBlackout: 'yes', settings: 'all' },
          CONTEXT,
        ),
      ),
    ).toBe('vj_effect_flag_invalid');
    expect(
      failureCodeOf(
        ruleSetEffects(
          state,
          { speed: 2, isBlackout: true, settings: 'all' },
          CONTEXT,
        ),
      ),
    ).toBe('vj_effect_unknown');
    expect(
      failureCodeOf(
        ruleSetEffects(
          state,
          { settings: { glitch: { amount: 2 } }, isImmediate: 'yes' },
          CONTEXT,
        ),
      ),
    ).toBe('vj_effect_amount_invalid');
    expect(
      failureCodeOf(
        ruleSetEffects(
          state,
          { settings: { freeze: { isOn: true }, reverse: { isOn: true } } },
          CONTEXT,
        ),
      ),
    ).toBe('vj_effect_exclusive_conflict');
    const eightOn: VjEffectSettings = {};
    for (const effectId of VJ_EFFECT_IDS.slice(0, 8)) {
      eightOn[effectId] = { isOn: true, amount: 0.5, variant: null };
    }
    eightOn.invert = { isOn: true, amount: 1, variant: 'steady' };
    eightOn.tint = { isOn: true, amount: 0.5, variant: 'coral' };
    eightOn.duotone = { isOn: true, amount: 1, variant: 'plum-coral' };
    eightOn.prideGrade = { isOn: true, amount: 0.6, variant: 'rainbow' };
    expect(
      failureCodeOf(
        ruleSetEffects(
          stageWithSettings(eightOn),
          { settings: { vhs: { isOn: true } } },
          CONTEXT,
        ),
      ),
    ).toBe('vj_effects_too_many');
    expect(
      failureCodeOf(
        ruleSetEffects(state, { speed: 2, isImmediate: 'yes' }, CONTEXT),
      ),
    ).toBe('vj_effect_flag_invalid');
  });

  it('answers vj_patch_empty for isImmediate alone', () => {
    expect(
      failureCodeOf(ruleSetEffects(state, { isImmediate: true }, CONTEXT)),
    ).toBe('vj_patch_empty');
    expect(failureCodeOf(ruleSetEffects(state, {}, CONTEXT))).toBe(
      'vj_patch_empty',
    );
  });

  it('turns an effect on with only isOn and keeps its default amount and variant', () => {
    const nextState = acceptedStateOf(
      ruleSetEffects(state, { settings: { tint: { isOn: true } } }, CONTEXT),
    );
    expect(nextState.effects.settings).toEqual({
      tint: { isOn: true, amount: 0.5, variant: 'coral' },
    });
    expect(nextState.effects.speed).toBe(1);
    expect(nextState.effects.isBlackout).toBe(false);
  });

  it('resets an effect with null', () => {
    const glitchOn = stageWithSettings({
      glitch: { isOn: true, amount: 0.8, variant: null },
      tint: { isOn: true, amount: 0.7, variant: 'plum' },
    });
    const nextState = acceptedStateOf(
      ruleSetEffects(glitchOn, { settings: { glitch: null } }, CONTEXT),
    );
    expect(nextState.effects.settings).toEqual({
      tint: { isOn: true, amount: 0.7, variant: 'plum' },
    });
  });

  it('allows isImmediate with blackout alone', () => {
    const result = ruleSetEffects(
      state,
      { isBlackout: true, isImmediate: true },
      CONTEXT,
    );
    expect(acceptedStateOf(result).effects.isBlackout).toBe(true);
    expect(result.accepted?.isImmediate).toBe(true);
    expect(
      failureCodeOf(
        ruleSetEffects(
          state,
          { isBlackout: true, speed: 2, isImmediate: true },
          CONTEXT,
        ),
      ),
    ).toBe('vj_immediate_not_allowed');
    const withoutFlag = ruleSetEffects(state, { isBlackout: true }, CONTEXT);
    expect(withoutFlag.accepted?.isImmediate).toBe(false);
  });

  it('turns reverse off when freeze goes on', () => {
    const reverseOn = stageWithSettings({
      reverse: { isOn: true, amount: 1, variant: null },
    });
    const nextState = acceptedStateOf(
      ruleSetEffects(
        reverseOn,
        { settings: { freeze: { isOn: true } } },
        CONTEXT,
      ),
    );
    expect(nextState.effects.settings).toEqual({
      freeze: { isOn: true, amount: 1, variant: null },
    });
  });

  it('allows isImmediate when the strobe stops and refuses it when it starts', () => {
    const strobing: VjStageState = {
      ...state,
      effects: { ...state.effects, isStrobing: true, strobeStartedAt: NOW },
    };
    const stopResult = ruleSetStrobe(
      strobing,
      { isStrobing: false, isImmediate: true },
      CONTEXT,
    );
    expect(acceptedStateOf(stopResult).effects.isStrobing).toBe(false);
    expect(stopResult.accepted?.isImmediate).toBe(true);
    expect(
      failureCodeOf(
        ruleSetStrobe(state, { isStrobing: true, isImmediate: true }, CONTEXT),
      ),
    ).toBe('vj_immediate_not_allowed');
    expect(
      failureCodeOf(ruleSetStrobe(state, { isStrobing: 'on' }, CONTEXT)),
    ).toBe('vj_effect_flag_invalid');
    const startResult = ruleSetStrobe(state, { isStrobing: true }, CONTEXT);
    expect(acceptedStateOf(startResult).effects.isStrobing).toBe(true);
    expect(acceptedStateOf(startResult).effects.strobeStartedAt).toBeNull();
    expect(startResult.accepted?.isImmediate).toBe(false);
  });

  it('restores effects leniently', () => {
    const tenOn: Record<string, unknown> = {};
    const tenIds = [
      'monochrome',
      'saturate',
      'contrast',
      'thermal',
      'hueCycle',
      'hueShift',
      'vhs',
      'filmGrain',
      'scanlines',
      'crt',
    ] as const;
    for (const effectId of tenIds) {
      tenOn[effectId] = { isOn: true, amount: 0.3, variant: null };
    }
    const restored = restoredVjEffects(
      {
        speed: 2,
        isBlackout: true,
        isStrobing: true,
        strobeStartedAt: NOW,
        settings: {
          ...tenOn,
          tint: { isOn: true, amount: 0.5, variant: 'chartreuse-ish' },
          freeze: { isOn: true, amount: 1, variant: null },
          reverse: { isOn: true, amount: 1, variant: null },
          notAnEffect: { isOn: true, amount: 0.5, variant: null },
        },
      },
      state.effects,
    );
    const onIds = VJ_EFFECT_IDS.filter(
      (effectId) => restored.settings[effectId]?.isOn === true,
    );
    expect(onIds).toEqual(tenIds.slice(0, 8));
    expect(restored.settings.crt).toEqual({
      isOn: false,
      amount: 0.3,
      variant: null,
    });
    expect(restored.settings.tint).toBeUndefined();
    expect(restored.settings.freeze).toBeUndefined();
    expect(restored.speed).toBe(2);
    expect(restored.isBlackout).toBe(true);
    expect(restored.isStrobing).toBe(false);
    expect(restored.strobeStartedAt).toBeNull();

    const playheads = restoredVjEffects(
      {
        settings: {
          freeze: { isOn: true, amount: 1, variant: null },
          reverse: { isOn: true, amount: 1, variant: null },
        },
      },
      state.effects,
    );
    expect(playheads.settings).toEqual({
      freeze: { isOn: true, amount: 1, variant: null },
    });

    expect(
      restoredVjEffects(
        { speed: 3, isBlackout: 'yes', settings: [] },
        state.effects,
      ),
    ).toEqual(state.effects);
    expect(restoredVjEffects(null, state.effects)).toEqual(state.effects);
  });
});
