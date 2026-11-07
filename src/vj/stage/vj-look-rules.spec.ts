import {
  createVjStageState,
  VJ_LIMITS,
  type VjStageState,
} from '../vj.contract';
import {
  restoredVjCountdown,
  restoredVjEventCard,
  restoredVjLogo,
  restoredVjOverlay,
  restoredVjTransition,
  ruleResetLook,
  ruleSetCountdown,
  ruleSetEventCard,
  ruleSetLogo,
  ruleSetOverlay,
  ruleSetTransition,
} from './vj-look-rules';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleContext,
} from './vj-rule-kit';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const SCREEN_ID = '77777777-7777-4777-8777-777777777777';

/** The context of the apply step, with the given lookups (null for prepare). */
function contextWith(lookups: VjLookupResults | null): VjRuleContext {
  return {
    now: NOW,
    lookups,
    connectedScreenIds: new Set<string>(),
    isLeadMicOn: false,
  };
}

const PREPARE_CONTEXT = contextWith(null);
const APPLY_CONTEXT = contextWith(EMPTY_VJ_LOOKUP_RESULTS);

function baseState(): VjStageState {
  return createVjStageState(STAGE_EPOCH, NOW);
}

/** Lookups answering the active pack with the given event id, or no pack. */
function packLookups(
  answer: { eventId: string | null } | null,
): VjLookupResults {
  return {
    ...EMPTY_VJ_LOOKUP_RESULTS,
    packs: new Map([[PACK_ID, answer]]),
  };
}

function codeOf(result: VjCommandRuleResult): string | null {
  return result.failure === null ? null : result.failure.code;
}

function acceptedOf(result: VjCommandRuleResult) {
  if (result.accepted === null) {
    throw new Error(`refused with ${String(codeOf(result))}`);
  }
  return result.accepted;
}

describe('vj look rules', () => {
  it('checks a setTransition patch in the contract order', () => {
    const state = baseState();
    const rule = (payload: Record<string, unknown>) =>
      codeOf(ruleSetTransition(state, payload));
    expect(rule({})).toBe('vj_patch_empty');
    expect(rule({ isImmediate: true })).toBe('vj_patch_empty');
    expect(rule({ mode: 'spin', length: { unit: 'parsecs', value: 1 } })).toBe(
      'vj_transition_mode_invalid',
    );
    expect(rule({ mode: 'iris', length: { unit: 'ms' } })).toBe(
      'vj_transition_length_invalid',
    );
    expect(rule({ length: { unit: 'ms', value: 800, extra: true } })).toBe(
      'vj_transition_length_invalid',
    );
    expect(rule({ mode: 'iris', isImmediate: true })).toBe(
      'vj_immediate_not_allowed',
    );
    expect(rule({ mode: 'iris', isImmediate: 'yes' })).toBe(
      'vj_effect_flag_invalid',
    );
    const accepted = acceptedOf(
      ruleSetTransition(state, { length: { unit: 'beats', value: 4 } }),
    );
    expect(accepted.nextState.transition).toEqual({
      mode: 'fade',
      length: { unit: 'beats', value: 4 },
    });
    expect(accepted.isImmediate).toBe(false);
    expect(accepted.lookups).toEqual([]);
  });

  it('answers vj_transition_length_invalid for 3 beats and vj_fade_out_of_range for 4001 ms', () => {
    const state = baseState();
    expect(
      codeOf(ruleSetTransition(state, { length: { unit: 'beats', value: 3 } })),
    ).toBe('vj_transition_length_invalid');
    expect(
      codeOf(ruleSetTransition(state, { length: { unit: 'ms', value: 4001 } })),
    ).toBe('vj_fade_out_of_range');
    expect(
      codeOf(ruleSetTransition(state, { length: { unit: 'ms', value: 4000 } })),
    ).toBeNull();
  });

  it('checks a setOverlay patch in the contract order', () => {
    const state = baseState();
    const rule = (payload: Record<string, unknown>) =>
      codeOf(ruleSetOverlay(state, payload));
    expect(rule({})).toBe('vj_patch_empty');
    expect(rule({ text: 42, style: 'huge' })).toBe('vj_overlay_text_invalid');
    expect(rule({ text: 'x'.repeat(81) })).toBe('vj_overlay_text_too_long');
    expect(rule({ style: 'huge', position: 'side' })).toBe(
      'vj_overlay_style_invalid',
    );
    expect(rule({ position: 'side', size: 'xxl' })).toBe(
      'vj_overlay_position_invalid',
    );
    expect(rule({ size: 'xxl', colorToken: 'teal' })).toBe(
      'vj_overlay_size_invalid',
    );
    expect(rule({ colorToken: 'teal', isVisible: 'yes' })).toBe(
      'vj_color_token_invalid',
    );
    expect(rule({ isVisible: 'yes', hideAfterMs: 5 })).toBe(
      'vj_effect_flag_invalid',
    );
    expect(rule({ text: 'Hi', isVisible: true, hideAfterMs: 999 })).toBe(
      'vj_overlay_hide_out_of_range',
    );
    expect(rule({ text: 'Hi', isVisible: true, hideAfterMs: 600_001 })).toBe(
      'vj_overlay_hide_out_of_range',
    );
    expect(rule({ text: 'Hi', isVisible: true, hideAfterMs: 1500.5 })).toBe(
      'vj_overlay_hide_out_of_range',
    );
    expect(rule({ text: '   ', isVisible: true })).toBe(
      'vj_overlay_text_blank',
    );
    expect(rule({ text: 'Hi', isVisible: true, isImmediate: true })).toBe(
      'vj_immediate_not_allowed',
    );
    const accepted = acceptedOf(
      ruleSetOverlay(state, {
        text: '  Hello dancefloor  ',
        style: 'neon',
        position: 'top',
        size: 'xl',
        colorToken: 'jade',
      }),
    );
    expect(accepted.nextState.overlay).toEqual({
      text: 'Hello dancefloor',
      style: 'neon',
      isVisible: false,
      position: 'top',
      size: 'xl',
      colorToken: 'jade',
      hideAt: null,
    });
  });

  it('hands back hideAfterMs for a visible overlay and null for a hidden one', () => {
    const state = baseState();
    const shown = acceptedOf(
      ruleSetOverlay(state, {
        text: 'Hello',
        isVisible: true,
        hideAfterMs: 5000,
      }),
    );
    expect(shown.overlayHideAfterMs).toBe(5000);
    expect(shown.nextState.overlay.isVisible).toBe(true);

    const visibleState: VjStageState = {
      ...state,
      overlay: {
        ...state.overlay,
        text: 'Hello',
        isVisible: true,
        hideAt: NOW + 4000,
      },
    };
    const turnedOff = acceptedOf(
      ruleSetOverlay(visibleState, { hideAfterMs: null }),
    );
    expect(turnedOff.overlayHideAfterMs).toBeNull();
    const kept = acceptedOf(ruleSetOverlay(visibleState, { style: 'ticker' }));
    expect(kept.overlayHideAfterMs).toBeUndefined();
    expect(kept.nextState.overlay.hideAt).toBe(NOW + 4000);

    const hidden = acceptedOf(
      ruleSetOverlay(visibleState, { isVisible: false, hideAfterMs: 5000 }),
    );
    expect(hidden.overlayHideAfterMs).toBeNull();
    expect(hidden.nextState.overlay.hideAt).toBeNull();
  });

  it('checks a setCountdown patch in the contract order', () => {
    const state = baseState();
    const rule = (payload: Record<string, unknown>) =>
      codeOf(ruleSetCountdown(state, payload, APPLY_CONTEXT));
    expect(rule({})).toBe('vj_patch_empty');
    expect(rule({ durationMs: 500, label: 7 })).toBe(
      'vj_countdown_out_of_range',
    );
    expect(rule({ durationMs: 60_000, label: 7 })).toBe(
      'vj_countdown_label_invalid',
    );
    expect(rule({ label: 'x'.repeat(41), isVisible: 'yes' })).toBe(
      'vj_countdown_label_too_long',
    );
    expect(rule({ label: 'Doors', isVisible: 'yes' })).toBe(
      'vj_effect_flag_invalid',
    );
    expect(rule({ isVisible: true })).toBe('vj_countdown_target_missing');
    expect(
      rule({ durationMs: 60_000, isVisible: true, isImmediate: true }),
    ).toBe('vj_immediate_not_allowed');
    const accepted = acceptedOf(
      ruleSetCountdown(
        state,
        { label: '  Doors open  ', targetAt: NOW + 90_000, isVisible: true },
        APPLY_CONTEXT,
      ),
    );
    expect(accepted.nextState.countdown).toEqual({
      isVisible: true,
      targetAt: NOW + 90_000,
      label: 'Doors open',
    });
    expect(accepted.lookups).toEqual([]);
  });

  it('refuses a countdown with both targetAt and durationMs', () => {
    expect(
      codeOf(
        ruleSetCountdown(
          baseState(),
          { targetAt: NOW + 5000, durationMs: 5000, label: 7 },
          APPLY_CONTEXT,
        ),
      ),
    ).toBe('vj_countdown_target_conflict');
  });

  it('refuses a countdown target under one second ahead', () => {
    const state = baseState();
    const rule = (payload: Record<string, unknown>) =>
      codeOf(ruleSetCountdown(state, payload, APPLY_CONTEXT));
    expect(rule({ targetAt: NOW + 999 })).toBe('vj_countdown_out_of_range');
    expect(rule({ targetAt: NOW + 1000 })).toBeNull();
    expect(rule({ targetAt: NOW + VJ_LIMITS.countdownLeadMsMax + 1 })).toBe(
      'vj_countdown_out_of_range',
    );
    expect(rule({ targetAt: NOW + 1500.5 })).toBe('vj_countdown_out_of_range');
    expect(rule({ durationMs: 999 })).toBe('vj_countdown_out_of_range');
    expect(rule({ durationMs: 86_400_001 })).toBe('vj_countdown_out_of_range');
  });

  it('sets targetAt from durationMs', () => {
    const accepted = acceptedOf(
      ruleSetCountdown(
        baseState(),
        { durationMs: 300_000, isVisible: true },
        APPLY_CONTEXT,
      ),
    );
    expect(accepted.nextState.countdown.targetAt).toBe(NOW + 300_000);
    expect(accepted.nextState.countdown.isVisible).toBe(true);
  });

  it('refuses a countdown label with a line break', () => {
    const state = baseState();
    for (const label of ['Doors\nopen', 'Doors\u2028open', 'Doors\u0085open']) {
      expect(codeOf(ruleSetCountdown(state, { label }, APPLY_CONTEXT))).toBe(
        'vj_countdown_label_invalid',
      );
    }
    expect(
      codeOf(ruleSetCountdown(state, { label: null }, APPLY_CONTEXT)),
    ).toBe('vj_countdown_label_invalid');
  });

  it('refuses a countdown label with a control character at either end before trimming', () => {
    const state = baseState();
    for (const label of ['\nDoors', 'Doors\n', '\tDoors', '\u2028Doors']) {
      expect(codeOf(ruleSetCountdown(state, { label }, APPLY_CONTEXT))).toBe(
        'vj_countdown_label_invalid',
      );
    }
    expect(
      codeOf(ruleSetCountdown(state, { label: '  Doors  ' }, APPLY_CONTEXT)),
    ).toBeNull();
  });

  it('refuses a visible countdown with no future target', () => {
    const state = baseState();
    const passedState: VjStageState = {
      ...state,
      countdown: { isVisible: false, targetAt: NOW - 1, label: 'Doors' },
    };
    expect(
      codeOf(ruleSetCountdown(state, { isVisible: true }, APPLY_CONTEXT)),
    ).toBe('vj_countdown_target_missing');
    expect(
      codeOf(ruleSetCountdown(passedState, { isVisible: true }, APPLY_CONTEXT)),
    ).toBe('vj_countdown_target_missing');
    const atNowState: VjStageState = {
      ...state,
      countdown: { isVisible: false, targetAt: NOW, label: '' },
    };
    expect(
      codeOf(ruleSetCountdown(atNowState, { isVisible: true }, APPLY_CONTEXT)),
    ).toBe('vj_countdown_target_missing');
    const hiddenAgain = acceptedOf(
      ruleSetCountdown(passedState, { isVisible: false }, APPLY_CONTEXT),
    );
    expect(hiddenAgain.nextState.countdown.targetAt).toBe(NOW - 1);
  });

  it('checks a setLogo patch in the contract order', () => {
    const state = baseState();
    const rule = (payload: Record<string, unknown>) =>
      codeOf(ruleSetLogo(state, payload));
    expect(rule({})).toBe('vj_patch_empty');
    expect(rule({ isVisible: 1, corner: 'middle' })).toBe(
      'vj_effect_flag_invalid',
    );
    expect(rule({ isVisible: true, corner: 'middle' })).toBe(
      'vj_logo_corner_invalid',
    );
    expect(rule({ isVisible: true, isImmediate: true })).toBe(
      'vj_immediate_not_allowed',
    );
    const accepted = acceptedOf(
      ruleSetLogo(state, { isVisible: true, corner: 'topLeft' }),
    );
    expect(accepted.nextState.logo).toEqual({
      isVisible: true,
      corner: 'topLeft',
    });
  });

  it('checks a setEventCard patch in the contract order', () => {
    const state = baseState();
    const rule = (
      payload: Record<string, unknown>,
      context: VjRuleContext = APPLY_CONTEXT,
    ) => codeOf(ruleSetEventCard(state, payload, context));
    expect(rule({})).toBe('vj_patch_empty');
    expect(rule({ isVisible: 'yes', kind: 'poster' })).toBe(
      'vj_effect_flag_invalid',
    );
    expect(rule({ isVisible: true, kind: 'poster' })).toBe(
      'vj_event_card_kind_invalid',
    );
    expect(rule({ isVisible: true, isImmediate: true })).toBe(
      'vj_immediate_not_allowed',
    );
    expect(rule({ isVisible: true }, PREPARE_CONTEXT)).toBe(
      'vj_event_card_no_event',
    );
    const packState: VjStageState = { ...state, activePackId: PACK_ID };
    for (const lookups of [
      EMPTY_VJ_LOOKUP_RESULTS,
      packLookups(null),
      packLookups({ eventId: null }),
    ]) {
      expect(
        codeOf(
          ruleSetEventCard(
            packState,
            { isVisible: true },
            contextWith(lookups),
          ),
        ),
      ).toBe('vj_event_card_no_event');
    }
    const accepted = acceptedOf(
      ruleSetEventCard(
        packState,
        { isVisible: true, kind: 'nextEvent' },
        contextWith(packLookups({ eventId: EVENT_ID })),
      ),
    );
    expect(accepted.nextState.eventCard).toEqual({
      isVisible: true,
      kind: 'nextEvent',
    });
  });

  it('reads the active pack only when the event card shows', () => {
    const state: VjStageState = { ...baseState(), activePackId: PACK_ID };
    const shown = acceptedOf(
      ruleSetEventCard(state, { isVisible: true }, PREPARE_CONTEXT),
    );
    expect(shown.lookups).toEqual([{ kind: 'pack', packId: PACK_ID }]);
    const kindOnly = acceptedOf(
      ruleSetEventCard(state, { kind: 'nextEvent' }, PREPARE_CONTEXT),
    );
    expect(kindOnly.lookups).toEqual([]);
    const visibleState: VjStageState = {
      ...state,
      eventCard: { isVisible: true, kind: 'qr' },
    };
    const hidden = acceptedOf(
      ruleSetEventCard(visibleState, { isVisible: false }, PREPARE_CONTEXT),
    );
    expect(hidden.lookups).toEqual([]);
    const kindWhileShown = acceptedOf(
      ruleSetEventCard(visibleState, { kind: 'nextEvent' }, PREPARE_CONTEXT),
    );
    expect(kindWhileShown.lookups).toEqual([{ kind: 'pack', packId: PACK_ID }]);
  });

  it('checks a resetLook payload and accepts isImmediate', () => {
    const state = baseState();
    expect(codeOf(ruleResetLook(state, { isImmediate: 'yes' }))).toBe(
      'vj_effect_flag_invalid',
    );
    expect(
      acceptedOf(ruleResetLook(state, { isImmediate: true })).isImmediate,
    ).toBe(true);
    const plain = acceptedOf(ruleResetLook(state, {}));
    expect(plain.isImmediate).toBe(false);
    expect(plain.overlayHideAfterMs).toBeNull();
    expect(plain.nextState).toEqual(state);
  });

  it('resets exactly the contract field list and keeps blackout and overrides', () => {
    const base = baseState();
    const state: VjStageState = {
      ...base,
      activePackId: PACK_ID,
      liveClipId: CLIP_ID,
      clipSequence: 3,
      transition: { mode: 'iris', length: { unit: 'beats', value: 4 } },
      overlay: {
        text: 'Hello',
        style: 'neon',
        isVisible: true,
        position: 'top',
        size: 'xl',
        colorToken: 'jade',
        hideAt: NOW + 5000,
      },
      countdown: { isVisible: true, targetAt: NOW + 60_000, label: 'Doors' },
      logo: { isVisible: true, corner: 'topLeft' },
      eventCard: { isVisible: true, kind: 'nextEvent' },
      effects: {
        speed: 2,
        settings: { glitch: { isOn: true, amount: 0.5, variant: null } },
        isStrobing: true,
        isBlackout: true,
        strobeStartedAt: NOW - 1000,
      },
      mix: { clipId: CLIP_ID, amount: 0.4, blendMode: 'screen' },
      tempo: {
        bpm: 128,
        downbeatAt: NOW - 200,
        quantize: 'bar',
        source: 'tap',
      },
      shuffle: { ...base.shuffle, isOn: true },
      recentClipIds: [CLIP_ID],
      screenOverrides: {
        [SCREEN_ID]: {
          clipId: null,
          generatorId: 'plasma',
          generatorVariant: null,
        },
      },
      activeSetlistId: STAGE_EPOCH,
      setlistIndex: 2,
    };
    const accepted = acceptedOf(ruleResetLook(state, {}));
    expect(accepted.nextState).toEqual({
      ...state,
      effects: {
        speed: 1,
        settings: {},
        isStrobing: false,
        isBlackout: true,
        strobeStartedAt: null,
      },
      overlay: { ...state.overlay, isVisible: false, hideAt: null },
      countdown: { ...state.countdown, isVisible: false },
      logo: { ...state.logo, isVisible: false },
      eventCard: { ...state.eventCard, isVisible: false },
      mix: { clipId: null, amount: 0, blendMode: 'normal' },
    });
    expect(accepted.lookups).toEqual([]);
    expect(accepted.isLookSwitch).toBe(false);
  });

  it('restores a stale overlay hidden and a finished countdown hidden', () => {
    const defaults = baseState();
    const staleOverlay = restoredVjOverlay(
      { ...defaults.overlay, text: 'Hello', isVisible: true, hideAt: NOW },
      defaults.overlay,
      NOW,
    );
    expect(staleOverlay.isVisible).toBe(false);
    expect(staleOverlay.hideAt).toBeNull();
    expect(staleOverlay.text).toBe('Hello');

    const liveOverlay = restoredVjOverlay(
      {
        text: 'Hello',
        isVisible: true,
        hideAt: NOW + 3000,
        style: 'bogus',
        position: 'top',
        size: 'm',
        colorToken: 'teal',
      },
      defaults.overlay,
      NOW,
    );
    expect(liveOverlay).toEqual({
      text: 'Hello',
      style: 'big',
      isVisible: true,
      position: 'top',
      size: 'm',
      colorToken: 'cream',
      hideAt: NOW + 3000,
    });
    const cappedOverlay = restoredVjOverlay(
      { text: 'Hello', isVisible: true, hideAt: NOW + 10_000_000 },
      defaults.overlay,
      NOW,
    );
    expect(cappedOverlay.hideAt).toBe(NOW + VJ_LIMITS.overlayHideAfterMsMax);
    expect(
      restoredVjOverlay({ text: '', isVisible: true }, defaults.overlay, NOW)
        .isVisible,
    ).toBe(false);

    const finished = restoredVjCountdown(
      {
        isVisible: true,
        targetAt: NOW - VJ_LIMITS.countdownHoldMs,
        label: 'Doors',
      },
      defaults.countdown,
      NOW,
    );
    expect(finished).toEqual({
      isVisible: false,
      targetAt: NOW - VJ_LIMITS.countdownHoldMs,
      label: 'Doors',
    });
    const holding = restoredVjCountdown(
      { isVisible: true, targetAt: NOW - 5000, label: 'Doors\nopen' },
      defaults.countdown,
      NOW,
    );
    expect(holding).toEqual({
      isVisible: true,
      targetAt: NOW - 5000,
      label: '',
    });
    expect(
      restoredVjCountdown(
        { isVisible: true, targetAt: 'soon', label: 'Doors' },
        defaults.countdown,
        NOW,
      ).isVisible,
    ).toBe(false);
  });

  it('restores the transition, logo and event card field by field', () => {
    const defaults = baseState();
    expect(
      restoredVjTransition(
        { mode: 'iris', length: { unit: 'beats', value: 3 } },
        defaults.transition,
      ),
    ).toEqual({ mode: 'iris', length: defaults.transition.length });
    expect(
      restoredVjTransition(
        { mode: 'spin', length: { unit: 'beats', value: 8 } },
        defaults.transition,
      ),
    ).toEqual({ mode: 'fade', length: { unit: 'beats', value: 8 } });
    expect(restoredVjTransition('junk', defaults.transition)).toEqual(
      defaults.transition,
    );
    expect(
      restoredVjLogo({ isVisible: true, corner: 'middle' }, defaults.logo),
    ).toEqual({ isVisible: true, corner: 'bottomRight' });
    expect(
      restoredVjEventCard(
        { isVisible: true, kind: 'nextEvent' },
        defaults.eventCard,
        false,
      ),
    ).toEqual({ isVisible: false, kind: 'nextEvent' });
    expect(
      restoredVjEventCard(
        { isVisible: true, kind: 'poster' },
        defaults.eventCard,
        true,
      ),
    ).toEqual({ isVisible: true, kind: 'qr' });
  });
});
