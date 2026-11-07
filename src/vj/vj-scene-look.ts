/**
 * Scene look validation and the stored-look normaliser (contract 3.7). Scene
 * writes run `checkVjSceneLook`, which names the first bad field as a dot path
 * of schema names (`lookField`); scene reads run `normalizeStoredVjSceneLook`,
 * which never refuses, so a later catalog change never breaks an old scene.
 * Both share the field rules of `vj-field-checks.ts` with the socket commands.
 * Pure functions over plain values: they import the contract, the field
 * checks and the rule kit and nothing else.
 */
import {
  VJ_EFFECT_CATALOG,
  VJ_EFFECT_IDS,
  VJ_LIMITS,
  createVjStageState,
  vjSceneLookOf,
} from './vj.contract';
import type {
  VjEffectSetting,
  VjEffectSettings,
  VjMix,
  VjOverlay,
  VjSceneLook,
  VjSceneSource,
  VjSpeed,
  VjTransition,
} from './vj.contract';
import {
  canonicalVjEffectSettings,
  checkVjEffectSettingsPatch,
  checkVjGeneratorChoice,
  checkVjMixFields,
  checkVjOverlayFields,
  checkVjTransitionFields,
  isVjSpeed,
  mergeVjEffectSettings,
} from './vj-field-checks';
import { hasExactlyKeys, isRecord, isUuidString } from './stage/vj-rule-kit';

/** A scene write's look check: the canonical look and the clips it names, or
 *  the dot path of the first bad field (`""` for the whole look). */
export type VjSceneLookCheck =
  | {
      isValid: true;
      look: VjSceneLook;
      clipIds: { sourceClipId: string | null; mixClipId: string | null };
    }
  | { isValid: false; lookField: string };

/** The keys of a look, of each of its parts and of each source kind. */
const LOOK_KEYS = ['source', 'effects', 'transition', 'overlay', 'mix'];
const EFFECTS_KEYS = ['speed', 'settings'];
const TRANSITION_KEYS = ['mode', 'length'];
const OVERLAY_KEYS = [
  'text',
  'style',
  'isVisible',
  'position',
  'size',
  'colorToken',
];
const MIX_KEYS = ['clipId', 'amount', 'blendMode'];
const CLIP_SOURCE_KEYS = ['kind', 'clipId'];
const GENERATOR_SOURCE_KEYS = ['kind', 'generatorId', 'generatorVariant'];

/** A part's answer inside the look check: the canonical part, or the dot
 *  path of its first bad field. */
type VjLookPartResult<Part> =
  { lookField: string; part: null } | { lookField: null; part: Part };

function refusePart<Part>(lookField: string): VjLookPartResult<Part> {
  return { lookField, part: null };
}

function acceptPart<Part>(part: Part): VjLookPartResult<Part> {
  return { lookField: null, part };
}

/** `prefix.path`, or `prefix` alone when the path names the whole value. */
function joinLookField(prefix: string, path: string): string {
  return path === '' ? prefix : `${prefix}.${path}`;
}

/** The look's UTF-8 JSON size in bytes; Infinity when it does not serialise. */
function lookByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Step 2: null, a clip source with a uuid, or a generator source with a
 *  catalog id and a variant valid for it; no extra keys. */
function checkSource(value: unknown): VjLookPartResult<VjSceneSource | null> {
  if (value === null) {
    return acceptPart(null);
  }
  if (!isRecord(value)) {
    return refusePart('source');
  }
  if (value.kind === 'clip') {
    if (!hasExactlyKeys(value, CLIP_SOURCE_KEYS)) {
      return refusePart('source');
    }
    if (!isUuidString(value.clipId)) {
      return refusePart('source.clipId');
    }
    return acceptPart({ kind: 'clip', clipId: value.clipId.toLowerCase() });
  }
  if (value.kind === 'generator') {
    if (!hasExactlyKeys(value, GENERATOR_SOURCE_KEYS)) {
      return refusePart('source');
    }
    const choice = checkVjGeneratorChoice(
      value.generatorId,
      value.generatorVariant,
      { isVariantRequired: true },
    );
    if (choice.failure !== null) {
      return refusePart(joinLookField('source', choice.failure.path));
    }
    return acceptPart({ kind: 'generator', ...choice.value });
  }
  return refusePart('source.kind');
}

/** Step 3: exactly speed and settings; complete entries, at most 8 on, at
 *  most one playhead effect on. */
function checkEffects(
  value: unknown,
): VjLookPartResult<{ speed: VjSpeed; settings: VjEffectSettings }> {
  if (!isRecord(value) || !hasExactlyKeys(value, EFFECTS_KEYS)) {
    return refusePart('effects');
  }
  if (!isVjSpeed(value.speed)) {
    return refusePart('effects.speed');
  }
  const patchCheck = checkVjEffectSettingsPatch(value.settings, {
    isComplete: true,
  });
  if (patchCheck.failure !== null) {
    return refusePart(
      joinLookField('effects.settings', patchCheck.failure.path),
    );
  }
  const merged = mergeVjEffectSettings({}, patchCheck.value);
  if (merged.failure !== null) {
    return refusePart(joinLookField('effects.settings', merged.failure.path));
  }
  return acceptPart({ speed: value.speed, settings: merged.value });
}

/** Step 4: exactly mode and length, with the stage:setTransition rules. */
function checkTransition(value: unknown): VjLookPartResult<VjTransition> {
  if (!isRecord(value) || !hasExactlyKeys(value, TRANSITION_KEYS)) {
    return refusePart('transition');
  }
  const fields = checkVjTransitionFields(value, { isComplete: true });
  if (fields.failure !== null) {
    return refusePart(joinLookField('transition', fields.failure.path));
  }
  return acceptPart(completeTransition(fields.value));
}

/** Step 5: exactly the six fields with the stage:setOverlay rules; visible
 *  with blank text fails at overlay.isVisible. */
function checkOverlay(
  value: unknown,
): VjLookPartResult<Omit<VjOverlay, 'hideAt'>> {
  if (!isRecord(value) || !hasExactlyKeys(value, OVERLAY_KEYS)) {
    return refusePart('overlay');
  }
  const fields = checkVjOverlayFields(value, { isComplete: true });
  if (fields.failure !== null) {
    return refusePart(joinLookField('overlay', fields.failure.path));
  }
  const overlay = completeOverlay(fields.value);
  if (overlay.isVisible && overlay.text === '') {
    return refusePart('overlay.isVisible');
  }
  return acceptPart(overlay);
}

/** Step 6: exactly clipId (uuid or null), amount (0..1) and blendMode. */
function checkMix(value: unknown): VjLookPartResult<VjMix> {
  if (!isRecord(value) || !hasExactlyKeys(value, MIX_KEYS)) {
    return refusePart('mix');
  }
  const fields = checkVjMixFields(value, { isComplete: true });
  if (fields.failure !== null) {
    return refusePart(joinLookField('mix', fields.failure.path));
  }
  return acceptPart(completeMix(fields.value));
}

/** The default look: nothing live, every part at its stage default. */
function defaultSceneLook(): VjSceneLook {
  return vjSceneLookOf(createVjStageState('', 0));
}

/** A checked transition with every field present, as a fresh literal. */
function completeTransition(fields: Partial<VjTransition>): VjTransition {
  const defaults = defaultSceneLook().transition;
  const length = fields.length ?? defaults.length;
  return {
    mode: fields.mode ?? defaults.mode,
    length: { unit: length.unit, value: length.value },
  };
}

/** A checked overlay with every field present, in contract field order. */
function completeOverlay(
  fields: Partial<Omit<VjOverlay, 'hideAt'>>,
): Omit<VjOverlay, 'hideAt'> {
  const defaults = defaultSceneLook().overlay;
  return {
    text: fields.text ?? defaults.text,
    style: fields.style ?? defaults.style,
    isVisible: fields.isVisible ?? defaults.isVisible,
    position: fields.position ?? defaults.position,
    size: fields.size ?? defaults.size,
    colorToken: fields.colorToken ?? defaults.colorToken,
  };
}

/** A checked mix with every field present, in contract field order. */
function completeMix(fields: Partial<VjMix>): VjMix {
  const defaults = defaultSceneLook().mix;
  return {
    clipId: fields.clipId === undefined ? defaults.clipId : fields.clipId,
    amount: fields.amount ?? defaults.amount,
    blendMode: fields.blendMode ?? defaults.blendMode,
  };
}

/** Contract 3.7 steps 1 to 6, first failure wins; the look comes back canonical. */
export function checkVjSceneLook(value: unknown): VjSceneLookCheck {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, LOOK_KEYS) ||
    lookByteLength(value) > VJ_LIMITS.sceneLookMaxBytes
  ) {
    return { isValid: false, lookField: '' };
  }
  const source = checkSource(value.source);
  if (source.lookField !== null) {
    return { isValid: false, lookField: source.lookField };
  }
  const effects = checkEffects(value.effects);
  if (effects.lookField !== null) {
    return { isValid: false, lookField: effects.lookField };
  }
  const transition = checkTransition(value.transition);
  if (transition.lookField !== null) {
    return { isValid: false, lookField: transition.lookField };
  }
  const overlay = checkOverlay(value.overlay);
  if (overlay.lookField !== null) {
    return { isValid: false, lookField: overlay.lookField };
  }
  const mix = checkMix(value.mix);
  if (mix.lookField !== null) {
    return { isValid: false, lookField: mix.lookField };
  }
  return {
    isValid: true,
    look: {
      source: source.part,
      effects: effects.part,
      transition: transition.part,
      overlay: overlay.part,
      mix: mix.part,
    },
    clipIds: {
      sourceClipId:
        source.part !== null && source.part.kind === 'clip'
          ? source.part.clipId
          : null,
      mixClipId: mix.part.clipId,
    },
  };
}

/** A stored source read leniently: extra keys ignored, an absent generator
 *  variant takes the default, anything unreadable reads as null. */
function readStoredSource(value: unknown): VjSceneSource | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === 'clip') {
    return isUuidString(value.clipId)
      ? { kind: 'clip', clipId: value.clipId.toLowerCase() }
      : null;
  }
  if (value.kind === 'generator') {
    const choice = checkVjGeneratorChoice(
      value.generatorId,
      value.generatorVariant,
      { isVariantRequired: false },
    );
    return choice.failure === null
      ? { kind: 'generator', ...choice.value }
      : null;
  }
  return null;
}

/** Stored settings read leniently, in catalog order: an unknown id or a bad
 *  entry is dropped; an entry past the 8-on cap or a second playhead effect
 *  on is kept turned off. */
function readStoredSettings(value: unknown): VjEffectSettings {
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
    const entryCheck = checkVjEffectSettingsPatch(
      { [effectId]: value[effectId] },
      { isComplete: true },
    );
    const entry = entryCheck.value?.[effectId];
    if (entry === undefined || entry === null) {
      continue;
    }
    const setting = entry as VjEffectSetting;
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

/** A stored part through its strict rules; a bad part takes its default. */
function readStoredPart<Part>(
  value: unknown,
  check: (part: unknown) => VjLookPartResult<Part>,
  fallback: Part,
): Part {
  const result = check(value);
  return result.lookField === null ? result.part : fallback;
}

/** The read side: a stored look through the same rules, leniently (an unknown effect id or a bad entry is dropped, a bad part takes its default). Never throws. */
export function normalizeStoredVjSceneLook(value: unknown): VjSceneLook {
  const defaults = defaultSceneLook();
  if (!isRecord(value)) {
    return defaults;
  }
  const storedEffects = isRecord(value.effects) ? value.effects : {};
  return {
    source: readStoredSource(value.source),
    effects: {
      speed: isVjSpeed(storedEffects.speed)
        ? storedEffects.speed
        : defaults.effects.speed,
      settings: readStoredSettings(storedEffects.settings),
    },
    transition: readStoredPart(
      value.transition,
      (part) =>
        isRecord(part)
          ? checkTransition({ mode: part.mode, length: part.length })
          : refusePart('transition'),
      defaults.transition,
    ),
    overlay: readStoredPart(
      value.overlay,
      (part) =>
        isRecord(part)
          ? checkOverlay(pickFields(part, OVERLAY_KEYS))
          : refusePart('overlay'),
      defaults.overlay,
    ),
    mix: readStoredPart(
      value.mix,
      (part) =>
        isRecord(part)
          ? checkMix(pickFields(part, MIX_KEYS))
          : refusePart('mix'),
      defaults.mix,
    ),
  };
}

/** The listed fields of a record, extra keys left out. */
function pickFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    picked[field] = value[field];
  }
  return picked;
}

/** The look with a deleted clip taken out (source to null, mix to { clipId: null, amount: 0, blendMode }), or null when the look does not name it. */
export function withoutVjSceneClip(
  look: VjSceneLook,
  clipId: string,
): VjSceneLook | null {
  const deletedClipId = clipId.toLowerCase();
  const isSourceNamed =
    look.source !== null &&
    look.source.kind === 'clip' &&
    look.source.clipId.toLowerCase() === deletedClipId;
  const isMixNamed =
    look.mix.clipId !== null && look.mix.clipId.toLowerCase() === deletedClipId;
  if (!isSourceNamed && !isMixNamed) {
    return null;
  }
  return {
    source: isSourceNamed ? null : look.source,
    effects: look.effects,
    transition: look.transition,
    overlay: look.overlay,
    mix: isMixNamed
      ? { clipId: null, amount: 0, blendMode: look.mix.blendMode }
      : look.mix,
  };
}
