/**
 * The effect rules of the `/vj` stage: `stage:setEffects` (contract 7.6),
 * `stage:setStrobe` (v1 rule plus `isImmediate`, contract 7.4) and the
 * effects a restored stage keeps (contract 7.13). Pure functions over the
 * state and the payload; the strobe start time is stamped later by the
 * quantize step, so these rules only flip `isStrobing`.
 */
import {
  VJ_EFFECT_CATALOG,
  VJ_EFFECT_IDS,
  VJ_LIMITS,
  type VjEffectSetting,
  type VjEffectSettings,
  type VjEffects,
} from '../vj.contract';
import {
  canonicalVjEffectSettings,
  checkVjEffectSettingsPatch,
  isVjSpeed,
  mergeVjEffectSettings,
} from '../vj-field-checks';
import {
  acceptRule,
  hasAnyField,
  isRecord,
  readVjImmediateFlag,
  refuseRule,
  type VjCommandRuleResult,
  type VjRuleFunction,
} from './vj-rule-kit';

/** The `stage:setEffects` fields that make a patch; `isImmediate` alone is empty. */
const SET_EFFECTS_PATCH_FIELDS = ['speed', 'isBlackout', 'settings'] as const;

/** `stage:setEffects`, contract 7.6 in its check order: speed, blackout, the
 *  settings entries in catalog order, playhead exclusivity, the 8-on cap,
 *  then `isImmediate`. The settings come back canonical. */
export const ruleSetEffects: VjRuleFunction = (
  state,
  payload,
): VjCommandRuleResult => {
  if (!hasAnyField(payload, SET_EFFECTS_PATCH_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const effects: VjEffects = { ...state.effects };
  if (payload.speed !== undefined) {
    if (!isVjSpeed(payload.speed)) {
      return refuseRule('vj_speed_invalid');
    }
    effects.speed = payload.speed;
  }
  if (payload.isBlackout !== undefined) {
    if (typeof payload.isBlackout !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    effects.isBlackout = payload.isBlackout;
  }
  if (payload.settings !== undefined) {
    const patchCheck = checkVjEffectSettingsPatch(payload.settings, {
      isComplete: false,
    });
    if (patchCheck.failure !== null) {
      return refuseRule(patchCheck.failure.code);
    }
    const mergeCheck = mergeVjEffectSettings(
      state.effects.settings,
      patchCheck.value,
    );
    if (mergeCheck.failure !== null) {
      return refuseRule(mergeCheck.failure.code);
    }
    effects.settings = mergeCheck.value;
  }
  const immediateRead = readVjImmediateFlag('stage:setEffects', payload);
  if (immediateRead.code !== null) {
    return refuseRule(immediateRead.code);
  }
  return acceptRule(
    { ...state, effects },
    { isImmediate: immediateRead.isImmediate },
  );
};

/** `stage:setStrobe`: the v1 flag rule, then `isImmediate` (allowed only when
 *  the strobe stops). `strobeStartedAt` is stamped by the quantize step. */
export const ruleSetStrobe: VjRuleFunction = (
  state,
  payload,
): VjCommandRuleResult => {
  if (typeof payload.isStrobing !== 'boolean') {
    return refuseRule('vj_effect_flag_invalid');
  }
  const immediateRead = readVjImmediateFlag('stage:setStrobe', payload);
  if (immediateRead.code !== null) {
    return refuseRule(immediateRead.code);
  }
  return acceptRule(
    {
      ...state,
      effects: { ...state.effects, isStrobing: payload.isStrobing },
    },
    { isImmediate: immediateRead.isImmediate },
  );
};

/** One restored settings entry through the complete-entry rules, or null when
 *  it fails them. */
function restoredSettingEntry(
  effectId: (typeof VJ_EFFECT_IDS)[number],
  value: unknown,
): VjEffectSetting | null {
  const entryCheck = checkVjEffectSettingsPatch(
    { [effectId]: value },
    { isComplete: true },
  );
  const entry = entryCheck.value?.[effectId];
  if (entry === undefined || entry === null) {
    return null;
  }
  return entry as VjEffectSetting;
}

/** Restored settings, contract 7.13: each entry checked on its own (a bad one
 *  dropped); past the 8-on cap, or a second playhead effect on, the entry is
 *  kept turned off. Catalog order decides which stay on. */
function restoredSettings(value: unknown): VjEffectSettings {
  if (!isRecord(value)) {
    return {};
  }
  const settings: VjEffectSettings = {};
  let onCount = 0;
  let hasPlayheadOn = false;
  for (const effectId of VJ_EFFECT_IDS) {
    if (!Object.prototype.hasOwnProperty.call(value, effectId)) {
      continue;
    }
    const setting = restoredSettingEntry(effectId, value[effectId]);
    if (setting === null) {
      continue;
    }
    const isPlayhead =
      VJ_EFFECT_CATALOG[effectId].exclusiveGroup === 'playhead';
    const isOn =
      setting.isOn &&
      onCount < VJ_LIMITS.effectsOnMax &&
      !(isPlayhead && hasPlayheadOn);
    if (isOn) {
      onCount += 1;
      hasPlayheadOn = hasPlayheadOn || isPlayhead;
    }
    settings[effectId] = {
      isOn,
      amount: setting.amount,
      variant: setting.variant,
    };
  }
  return canonicalVjEffectSettings(settings);
}

/** The effects a restored stage keeps (contract 7.13): an invalid speed or
 *  blackout takes its default, settings are read leniently, and the strobe
 *  always comes back off. */
export function restoredVjEffects(
  value: unknown,
  defaults: VjEffects,
): VjEffects {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    speed: isVjSpeed(source.speed) ? source.speed : defaults.speed,
    settings: restoredSettings(source.settings),
    isStrobing: false,
    isBlackout:
      typeof source.isBlackout === 'boolean'
        ? source.isBlackout
        : defaults.isBlackout,
    strobeStartedAt: null,
  };
}
