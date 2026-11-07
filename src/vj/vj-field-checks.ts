/**
 * Field rules shared by the `/vj` socket command rules (contract 7.5 and 7.6)
 * and the scene look validation (contract 3.7), written once so the two
 * always agree. Each check answers the socket code of the first bad field and
 * its dot path, built from schema names only. Pure functions over plain
 * values: they import the contract and the rule kit and nothing else.
 */
import {
  VJ_BLEND_MODES,
  VJ_COLOR_TOKENS,
  VJ_EFFECT_CATALOG,
  VJ_EFFECT_IDS,
  VJ_GENERATOR_CATALOG,
  VJ_GENERATOR_IDS,
  VJ_LIMITS,
  VJ_OVERLAY_POSITIONS,
  VJ_OVERLAY_SIZES,
  VJ_OVERLAY_STYLES,
  VJ_SPEEDS,
  VJ_TRANSITION_BEAT_COUNTS,
  VJ_TRANSITION_IDS,
  VJ_TRANSITION_LENGTH_UNITS,
  roundVjAmount,
} from './vj.contract';
import type {
  VjBlendMode,
  VjColorToken,
  VjEffectId,
  VjEffectSetting,
  VjEffectSettingPatch,
  VjEffectSettings,
  VjGeneratorId,
  VjMix,
  VjOverlay,
  VjOverlayPosition,
  VjOverlaySize,
  VjOverlayStyle,
  VjSocketErrorCode,
  VjSpeed,
  VjTransition,
  VjTransitionId,
  VjTransitionLength,
  VjTransitionLengthUnit,
} from './vj.contract';
import {
  hasControlCharacter,
  hasExactlyKeys,
  isFiniteInRange,
  isOneOf,
  isRecord,
  isSafeIntegerInRange,
  isUuidString,
} from './stage/vj-rule-kit';

/** The first bad field: its socket code and its dot path in schema names
 *  (`""` when the whole value is bad). */
export interface VjFieldFailure {
  code: VjSocketErrorCode;
  path: string;
}

/** A field check's answer: the first failure, or the checked value. */
export type VjFieldResult<Value> =
  { failure: VjFieldFailure; value: null } | { failure: null; value: Value };

/** A `stage:setEffects` settings patch after its field rules; null resets an
 *  effect to its off default. */
export type VjEffectSettingsPatch = Partial<
  Record<VjEffectId, VjEffectSettingPatch | null>
>;

/** The fields one effect setting may carry. */
const EFFECT_SETTING_FIELDS = ['isOn', 'amount', 'variant'] as const;

/** The two fields of a transition length. */
const TRANSITION_LENGTH_FIELDS = ['unit', 'value'] as const;

function refuseField<Value>(
  code: VjSocketErrorCode,
  path: string,
): VjFieldResult<Value> {
  return { failure: { code, path }, value: null };
}

function acceptField<Value>(value: Value): VjFieldResult<Value> {
  return { failure: null, value };
}

/** The catalog's off default of an effect, a fresh literal. */
function offDefaultSetting(effectId: VjEffectId): VjEffectSetting {
  const entry = VJ_EFFECT_CATALOG[effectId];
  return {
    isOn: false,
    amount: entry.defaultAmount,
    variant: entry.defaultVariant,
  };
}

/** Whether a value is one of an effect's variants (null exactly when it has none). */
function isEffectVariant(effectId: VjEffectId, value: unknown): boolean {
  const variants = VJ_EFFECT_CATALOG[effectId].variants;
  if (variants.length === 0) {
    return value === null;
  }
  return isOneOf<string>(variants, value);
}

/** Contract 7.6 step 4 for one entry: a null reset, or a plain object whose
 *  keys are a subset of the three fields, each checked in turn. isComplete
 *  requires all three fields and refuses a null entry. */
function checkEffectSettingEntry(
  effectId: VjEffectId,
  value: unknown,
  isComplete: boolean,
): VjFieldResult<VjEffectSettingPatch | null> {
  if (value === null && !isComplete) {
    return acceptField(null);
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (field) => !isOneOf<string>(EFFECT_SETTING_FIELDS, field),
    )
  ) {
    return refuseField('vj_effect_unknown', effectId);
  }
  const entry = VJ_EFFECT_CATALOG[effectId];
  const patch: VjEffectSettingPatch = {};
  if (value.isOn !== undefined || isComplete) {
    if (typeof value.isOn !== 'boolean') {
      return refuseField('vj_effect_flag_invalid', `${effectId}.isOn`);
    }
    patch.isOn = value.isOn;
  }
  if (value.amount !== undefined || isComplete) {
    if (!isFiniteInRange(value.amount, 0, 1)) {
      return refuseField('vj_effect_amount_invalid', `${effectId}.amount`);
    }
    const amount = roundVjAmount(value.amount);
    if (!entry.isAmountAdjustable && amount !== entry.defaultAmount) {
      return refuseField('vj_effect_amount_invalid', `${effectId}.amount`);
    }
    patch.amount = amount;
  }
  if (value.variant !== undefined || isComplete) {
    if (!isEffectVariant(effectId, value.variant)) {
      return refuseField('vj_effect_variant_invalid', `${effectId}.variant`);
    }
    patch.variant = value.variant as string | null;
  }
  return acceptField(patch);
}

/** Contract 7.6 steps 3 and 4. isComplete (scene looks) requires all three fields per entry and refuses null entries. */
export function checkVjEffectSettingsPatch(
  value: unknown,
  options: { isComplete: boolean },
): VjFieldResult<VjEffectSettingsPatch> {
  if (!isRecord(value)) {
    return refuseField('vj_effect_unknown', '');
  }
  const keys = Object.keys(value);
  if (
    keys.length > VJ_EFFECT_IDS.length ||
    keys.some((key) => !isOneOf<string>(VJ_EFFECT_IDS, key))
  ) {
    return refuseField('vj_effect_unknown', '');
  }
  const patch: VjEffectSettingsPatch = {};
  for (const effectId of VJ_EFFECT_IDS) {
    if (!Object.prototype.hasOwnProperty.call(value, effectId)) {
      continue;
    }
    const entryCheck = checkEffectSettingEntry(
      effectId,
      value[effectId],
      options.isComplete,
    );
    if (entryCheck.failure !== null) {
      return refuseField(entryCheck.failure.code, entryCheck.failure.path);
    }
    patch[effectId] = entryCheck.value;
  }
  return acceptField(patch);
}

/** Ids of `playhead` effects the patch turns on, in catalog order. */
function playheadIdsTurnedOn(patch: VjEffectSettingsPatch): VjEffectId[] {
  return VJ_EFFECT_IDS.filter(
    (effectId) =>
      VJ_EFFECT_CATALOG[effectId].exclusiveGroup === 'playhead' &&
      patch[effectId]?.isOn === true,
  );
}

/** Steps 5 and 6: merge over vjEffectSettingOf, playhead exclusivity, the 8-on cap; canonical result. */
export function mergeVjEffectSettings(
  current: VjEffectSettings,
  patch: VjEffectSettingsPatch,
): VjFieldResult<VjEffectSettings> {
  const playheadIds = playheadIdsTurnedOn(patch);
  if (playheadIds.length > 1) {
    return refuseField('vj_effect_exclusive_conflict', '');
  }
  const turnedOnPlayheadId = playheadIds[0] ?? null;
  const merged: VjEffectSettings = {};
  let onCount = 0;
  for (const effectId of VJ_EFFECT_IDS) {
    const base = current[effectId] ?? offDefaultSetting(effectId);
    const entryPatch = patch[effectId];
    const setting: VjEffectSetting =
      entryPatch === null
        ? offDefaultSetting(effectId)
        : {
            isOn: entryPatch?.isOn ?? base.isOn,
            amount: entryPatch?.amount ?? base.amount,
            variant:
              entryPatch?.variant === undefined
                ? base.variant
                : entryPatch.variant,
          };
    if (
      turnedOnPlayheadId !== null &&
      effectId !== turnedOnPlayheadId &&
      VJ_EFFECT_CATALOG[effectId].exclusiveGroup === 'playhead'
    ) {
      setting.isOn = false;
    }
    if (setting.isOn) {
      onCount += 1;
    }
    merged[effectId] = setting;
  }
  if (onCount > VJ_LIMITS.effectsOnMax) {
    return refuseField('vj_effects_too_many', '');
  }
  return acceptField(canonicalVjEffectSettings(merged));
}

/** Catalog order, off defaults dropped, amounts rounded to 0.01. */
export function canonicalVjEffectSettings(
  settings: VjEffectSettings,
): VjEffectSettings {
  const canonicalSettings: VjEffectSettings = {};
  for (const effectId of VJ_EFFECT_IDS) {
    const setting = settings[effectId];
    if (setting === undefined) {
      continue;
    }
    const entry = VJ_EFFECT_CATALOG[effectId];
    const amount = roundVjAmount(setting.amount);
    const isOffDefault =
      !setting.isOn &&
      amount === entry.defaultAmount &&
      setting.variant === entry.defaultVariant;
    if (isOffDefault) {
      continue;
    }
    canonicalSettings[effectId] = {
      isOn: setting.isOn,
      amount,
      variant: setting.variant,
    };
  }
  return canonicalSettings;
}

/** Whether a value is one of `VJ_SPEEDS`. */
export function isVjSpeed(value: unknown): value is VjSpeed {
  return isOneOf<VjSpeed>(VJ_SPEEDS, value);
}

/** A transition length: exactly `unit` and `value`; 'ms' an integer 0..4000,
 *  'beats' one of the beat counts. Every failure points at `length`. */
function checkTransitionLength(
  value: unknown,
): VjFieldResult<VjTransitionLength> {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, TRANSITION_LENGTH_FIELDS) ||
    !isOneOf<VjTransitionLengthUnit>(VJ_TRANSITION_LENGTH_UNITS, value.unit)
  ) {
    return refuseField('vj_transition_length_invalid', 'length');
  }
  if (value.unit === 'ms') {
    if (
      !isSafeIntegerInRange(
        value.value,
        VJ_LIMITS.fadeMsMin,
        VJ_LIMITS.fadeMsMax,
      )
    ) {
      return refuseField('vj_fade_out_of_range', 'length');
    }
    return acceptField({ unit: 'ms', value: value.value });
  }
  if (!isOneOf<number>(VJ_TRANSITION_BEAT_COUNTS, value.value)) {
    return refuseField('vj_transition_length_invalid', 'length');
  }
  return acceptField({ unit: 'beats', value: value.value });
}

/** stage:setTransition rules; isComplete requires both fields. */
export function checkVjTransitionFields(
  payload: Record<string, unknown>,
  options: { isComplete: boolean },
): VjFieldResult<Partial<VjTransition>> {
  const transition: Partial<VjTransition> = {};
  if (payload.mode !== undefined || options.isComplete) {
    if (!isOneOf<VjTransitionId>(VJ_TRANSITION_IDS, payload.mode)) {
      return refuseField('vj_transition_mode_invalid', 'mode');
    }
    transition.mode = payload.mode;
  }
  if (payload.length !== undefined || options.isComplete) {
    const lengthCheck = checkTransitionLength(payload.length);
    if (lengthCheck.failure !== null) {
      return refuseField(lengthCheck.failure.code, lengthCheck.failure.path);
    }
    transition.length = lengthCheck.value;
  }
  return acceptField(transition);
}

/** v1 overlay text rules, moved here (trim, control characters, 80 code points). */
export function checkVjOverlayText(value: unknown): VjFieldResult<string> {
  if (typeof value !== 'string') {
    return refuseField('vj_overlay_text_invalid', 'text');
  }
  const text = value.trim();
  if (hasControlCharacter(text)) {
    return refuseField('vj_overlay_text_invalid', 'text');
  }
  if (Array.from(text).length > VJ_LIMITS.overlayTextMax) {
    return refuseField('vj_overlay_text_too_long', 'text');
  }
  return acceptField(text);
}

/** The listed overlay fields after text: each field, its list and its code. */
const OVERLAY_LIST_FIELDS = [
  {
    field: 'style',
    list: VJ_OVERLAY_STYLES,
    code: 'vj_overlay_style_invalid',
  },
  {
    field: 'position',
    list: VJ_OVERLAY_POSITIONS,
    code: 'vj_overlay_position_invalid',
  },
  { field: 'size', list: VJ_OVERLAY_SIZES, code: 'vj_overlay_size_invalid' },
  {
    field: 'colorToken',
    list: VJ_COLOR_TOKENS,
    code: 'vj_color_token_invalid',
  },
] as const;

/** stage:setOverlay rules for text, style, position, size, colorToken, isVisible (blank check left to the caller). */
export function checkVjOverlayFields(
  payload: Record<string, unknown>,
  options: { isComplete: boolean },
): VjFieldResult<Partial<Omit<VjOverlay, 'hideAt'>>> {
  const overlay: Partial<Omit<VjOverlay, 'hideAt'>> = {};
  if (payload.text !== undefined || options.isComplete) {
    const textCheck = checkVjOverlayText(payload.text);
    if (textCheck.failure !== null) {
      return refuseField(textCheck.failure.code, textCheck.failure.path);
    }
    overlay.text = textCheck.value;
  }
  for (const { field, list, code } of OVERLAY_LIST_FIELDS) {
    const value = payload[field];
    if (value === undefined && !options.isComplete) {
      continue;
    }
    if (!isOneOf<string>(list, value)) {
      return refuseField(code, field);
    }
  }
  if (payload.style !== undefined) {
    overlay.style = payload.style as VjOverlayStyle;
  }
  if (payload.position !== undefined) {
    overlay.position = payload.position as VjOverlayPosition;
  }
  if (payload.size !== undefined) {
    overlay.size = payload.size as VjOverlaySize;
  }
  if (payload.colorToken !== undefined) {
    overlay.colorToken = payload.colorToken as VjColorToken;
  }
  if (payload.isVisible !== undefined || options.isComplete) {
    if (typeof payload.isVisible !== 'boolean') {
      return refuseField('vj_effect_flag_invalid', 'isVisible');
    }
    overlay.isVisible = payload.isVisible;
  }
  return acceptField(overlay);
}

/** stage:setMix field rules: clipId uuid or null (vj_clip_not_found), amount (vj_mix_amount_invalid, rounded), blendMode. */
export function checkVjMixFields(
  payload: Record<string, unknown>,
  options: { isComplete: boolean },
): VjFieldResult<Partial<VjMix>> {
  const mix: Partial<VjMix> = {};
  if (payload.clipId !== undefined || options.isComplete) {
    if (payload.clipId === null) {
      mix.clipId = null;
    } else if (isUuidString(payload.clipId)) {
      mix.clipId = payload.clipId.toLowerCase();
    } else {
      return refuseField('vj_clip_not_found', 'clipId');
    }
  }
  if (payload.amount !== undefined || options.isComplete) {
    if (!isFiniteInRange(payload.amount, 0, 1)) {
      return refuseField('vj_mix_amount_invalid', 'amount');
    }
    mix.amount = roundVjAmount(payload.amount);
  }
  if (payload.blendMode !== undefined || options.isComplete) {
    if (!isOneOf<VjBlendMode>(VJ_BLEND_MODES, payload.blendMode)) {
      return refuseField('vj_blend_mode_invalid', 'blendMode');
    }
    mix.blendMode = payload.blendMode;
  }
  return acceptField(mix);
}

/** A generator id and variant (vj_generator_invalid, vj_generator_variant_invalid); an absent variant takes the default when allowed. */
export function checkVjGeneratorChoice(
  generatorId: unknown,
  variant: unknown,
  options: { isVariantRequired: boolean },
): VjFieldResult<{
  generatorId: VjGeneratorId;
  generatorVariant: string | null;
}> {
  if (!isOneOf<VjGeneratorId>(VJ_GENERATOR_IDS, generatorId)) {
    return refuseField('vj_generator_invalid', 'generatorId');
  }
  const entry = VJ_GENERATOR_CATALOG[generatorId];
  if (variant === undefined) {
    if (options.isVariantRequired) {
      return refuseField('vj_generator_variant_invalid', 'generatorVariant');
    }
    return acceptField({
      generatorId,
      generatorVariant: entry.defaultVariant,
    });
  }
  const isValidVariant =
    entry.variants.length === 0
      ? variant === null
      : isOneOf<string>(entry.variants, variant);
  if (!isValidVariant) {
    return refuseField('vj_generator_variant_invalid', 'generatorVariant');
  }
  return acceptField({
    generatorId,
    generatorVariant: variant as string | null,
  });
}
