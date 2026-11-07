import { checkVjGeneratorChoice, checkVjMixFields } from '../vj-field-checks';
import {
  VJ_LIMITS,
  type VjMix,
  type VjScreenOverride,
  type VjSocketErrorCode,
  type VjStageState,
} from '../vj.contract';
import {
  acceptRule,
  hasAnyField,
  hasExactlyKeys,
  isRecord,
  isUuidString,
  readNullableUuid,
  readVjImmediateFlag,
  refuseRule,
  withVjLiveSource,
  type VjCommandLookup,
  type VjCommandRuleResult,
  type VjLookupResults,
  type VjRuleContext,
} from './vj-rule-kit';

/** The `stage:setMix` patch fields (contract 7.5). */
const VJ_SET_MIX_FIELDS = ['clipId', 'amount', 'blendMode'] as const;

/** The three fields of a screen override, exactly (contract 3.4). */
const VJ_SCREEN_OVERRIDE_KEYS = [
  'clipId',
  'generatorId',
  'generatorVariant',
] as const;

/** One clip lookup for a non-null clip id, none for null. */
function clipLookupsOf(clipId: string | null): VjCommandLookup[] {
  return clipId === null ? [] : [{ kind: 'clip', clipId }];
}

/** With lookups, whether the clip is unknown; the prepare step never refuses. */
function isClipUnknown(
  lookups: VjLookupResults | null,
  clipId: string | null,
): boolean {
  return (
    lookups !== null && clipId !== null && !lookups.existingClipIds.has(clipId)
  );
}

/** The six commands of this module; none of them accepts `isImmediate: true`. */
type VjSourceCommandName =
  | 'stage:setPack'
  | 'stage:goClip'
  | 'stage:goGenerator'
  | 'stage:setMix'
  | 'stage:swapMix'
  | 'stage:setScreenOverride';

/** The `isImmediate` refusal (contract 7.4, checked after the field rules and
 *  before the lookups, plan note 19), or null when the flag is absent or false. */
function immediateRefusalOf(
  name: VjSourceCommandName,
  payload: Record<string, unknown>,
): VjCommandRuleResult | null {
  const immediate = readVjImmediateFlag(name, payload);
  return immediate.code === null ? null : refuseRule(immediate.code);
}

/** `stage:setPack` (contract 7.5): v1, plus a pack change empties
 *  `shuffle.excludedClipIds`, and with lookups hides the event card when the
 *  new pack is null or links no event. Lists the pack lookup. */
export function ruleSetPack(
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  const packRead = readNullableUuid(payload.packId);
  if (!packRead.isValid) {
    return refuseRule('vj_pack_not_found');
  }
  const immediateRefusal = immediateRefusalOf('stage:setPack', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  const packId = packRead.id;
  const lookups: VjCommandLookup[] =
    packId === null ? [] : [{ kind: 'pack', packId }];
  const packRow =
    packId === null || context.lookups === null
      ? undefined
      : context.lookups.packs.get(packId);
  if (packId !== null && context.lookups !== null && !packRow) {
    return refuseRule('vj_pack_not_found');
  }
  if (packId === state.activePackId) {
    return acceptRule(state, { lookups });
  }
  // In the prepare step (no lookups) the card stays; the apply step decides.
  const isEventLinked = packId !== null && packRow?.eventId !== null;
  return acceptRule(
    {
      ...state,
      activePackId: packId,
      clipSequence: state.clipSequence + 1,
      shuffle: { ...state.shuffle, excludedClipIds: [] },
      eventCard: isEventLinked
        ? state.eventCard
        : { ...state.eventCard, isVisible: false },
    },
    { lookups },
  );
}

/** `stage:goClip` (contract 7.5): v1 through `withVjLiveSource`, so a clip
 *  clears the generator and leads the history, and null goes to black. A
 *  re-tap is never a noop: the sequence always grows. */
export function ruleGoClip(
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  const clipRead = readNullableUuid(payload.clipId);
  if (!clipRead.isValid) {
    return refuseRule('vj_clip_not_found');
  }
  const immediateRefusal = immediateRefusalOf('stage:goClip', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  const clipId = clipRead.id;
  if (isClipUnknown(context.lookups, clipId)) {
    return refuseRule('vj_clip_not_found');
  }
  return acceptRule(
    withVjLiveSource(state, clipId === null ? null : { kind: 'clip', clipId }),
    { lookups: clipLookupsOf(clipId) },
  );
}

/** `stage:goGenerator` (contract 7.5): an absent variant takes the default,
 *  null goes to black, and the same generator again still grows the sequence. */
export function ruleGoGenerator(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (payload.generatorId === null) {
    if (payload.variant !== undefined && payload.variant !== null) {
      return refuseRule('vj_generator_variant_invalid');
    }
    const immediateRefusal = immediateRefusalOf('stage:goGenerator', payload);
    return immediateRefusal ?? acceptRule(withVjLiveSource(state, null));
  }
  const choice = checkVjGeneratorChoice(payload.generatorId, payload.variant, {
    isVariantRequired: false,
  });
  if (choice.failure !== null) {
    return refuseRule(choice.failure.code);
  }
  const immediateRefusal = immediateRefusalOf('stage:goGenerator', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  return acceptRule(
    withVjLiveSource(state, { kind: 'generator', ...choice.value }),
  );
}

/** `stage:setMix` (contract 7.5): the field rules of `checkVjMixFields`;
 *  setting `clipId` to null also sets `amount` to 0. Lists the clip lookup for
 *  a non-null id, and an unknown clip answers after every field rule. */
export function ruleSetMix(
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  if (!hasAnyField(payload, VJ_SET_MIX_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const fields = checkVjMixFields(payload, { isComplete: false });
  if (fields.failure !== null) {
    return refuseRule(fields.failure.code);
  }
  const immediateRefusal = immediateRefusalOf('stage:setMix', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  const patch = fields.value;
  const clipId = patch.clipId === undefined ? null : patch.clipId;
  if (isClipUnknown(context.lookups, clipId)) {
    return refuseRule('vj_clip_not_found');
  }
  const mix: VjMix = { ...state.mix, ...patch };
  if (patch.clipId === null) {
    mix.amount = 0;
  }
  return acceptRule({ ...state, mix }, { lookups: clipLookupsOf(clipId) });
}

/** `stage:swapMix` (contract 7.5): the mix clip goes live through
 *  `withVjLiveSource` and the mix empties, keeping its blend mode. */
export function ruleSwapMix(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  const mixClipId = state.mix.clipId;
  if (mixClipId === null) {
    return refuseRule('vj_mix_empty');
  }
  const immediateRefusal = immediateRefusalOf('stage:swapMix', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  const swapped = withVjLiveSource(state, { kind: 'clip', clipId: mixClipId });
  return acceptRule({
    ...swapped,
    mix: { clipId: null, amount: 0, blendMode: state.mix.blendMode },
  });
}

/** What a screen override payload answers: a refusal code or the stored entry. */
type VjOverrideCheck =
  | { code: VjSocketErrorCode; override: null }
  | { code: null; override: VjScreenOverride };

/** The override field rules in the contract 7.5 order: exactly the three
 *  fields with exactly one source, the generator checks, the clip id shape. A
 *  clip override carries a null variant. */
function checkVjScreenOverride(value: unknown): VjOverrideCheck {
  if (!isRecord(value) || !hasExactlyKeys(value, VJ_SCREEN_OVERRIDE_KEYS)) {
    return { code: 'vj_override_invalid', override: null };
  }
  const hasClip = value.clipId !== null;
  const hasGenerator = value.generatorId !== null;
  if (hasClip === hasGenerator) {
    return { code: 'vj_override_invalid', override: null };
  }
  if (hasGenerator) {
    const choice = checkVjGeneratorChoice(
      value.generatorId,
      value.generatorVariant,
      { isVariantRequired: true },
    );
    if (choice.failure !== null) {
      return { code: choice.failure.code, override: null };
    }
    return { code: null, override: { clipId: null, ...choice.value } };
  }
  if (value.generatorVariant !== null) {
    return { code: 'vj_generator_variant_invalid', override: null };
  }
  if (!isUuidString(value.clipId)) {
    return { code: 'vj_clip_not_found', override: null };
  }
  return {
    code: null,
    override: {
      clipId: value.clipId.toLowerCase(),
      generatorId: null,
      generatorVariant: null,
    },
  };
}

/** The overrides without the screen's entry. */
function withoutScreenOverride(
  screenOverrides: Readonly<Record<string, VjScreenOverride>>,
  screenId: string,
): Record<string, VjScreenOverride> {
  return Object.fromEntries(
    Object.entries(screenOverrides).filter(
      ([overrideScreenId]) => overrideScreenId !== screenId,
    ),
  );
}

/** `stage:setScreenOverride` (contract 7.5): the screen must be connected;
 *  null removes its entry; else one source per override, at most
 *  `VJ_LIMITS.screenOverridesMax` entries. Lists the clip lookup when the
 *  override names a clip. */
export function ruleSetScreenOverride(
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  if (!isUuidString(payload.screenId)) {
    return refuseRule('vj_screen_not_attached');
  }
  const screenId = payload.screenId.toLowerCase();
  if (!context.connectedScreenIds.has(screenId)) {
    return refuseRule('vj_screen_not_attached');
  }
  if (payload.override === null) {
    const immediateRefusal = immediateRefusalOf(
      'stage:setScreenOverride',
      payload,
    );
    return (
      immediateRefusal ??
      acceptRule({
        ...state,
        screenOverrides: withoutScreenOverride(state.screenOverrides, screenId),
      })
    );
  }
  const check = checkVjScreenOverride(payload.override);
  if (check.code !== null) {
    return refuseRule(check.code);
  }
  const isNewEntry = !Object.hasOwn(state.screenOverrides, screenId);
  if (
    isNewEntry &&
    Object.keys(state.screenOverrides).length >= VJ_LIMITS.screenOverridesMax
  ) {
    return refuseRule('vj_overrides_too_many');
  }
  const immediateRefusal = immediateRefusalOf(
    'stage:setScreenOverride',
    payload,
  );
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  const override = check.override;
  if (isClipUnknown(context.lookups, override.clipId)) {
    return refuseRule('vj_clip_not_found');
  }
  return acceptRule(
    {
      ...state,
      screenOverrides: { ...state.screenOverrides, [screenId]: override },
    },
    { lookups: clipLookupsOf(override.clipId) },
  );
}

/** A restored mix (contract 7.13): each field through the `stage:setMix`
 *  rules on its own, an invalid one taking its default; a clip the reads did
 *  not find is dropped, and a mix without a clip comes back with amount 0. */
export function restoredVjMix(
  value: unknown,
  defaults: VjMix,
  isClipKnown: (clipId: string) => boolean,
): VjMix {
  if (!isRecord(value)) {
    return { ...defaults };
  }
  const clipField = checkVjMixFields(
    { clipId: value.clipId },
    { isComplete: false },
  );
  const restoredClipId =
    clipField.failure === null ? (clipField.value.clipId ?? null) : null;
  const clipId =
    restoredClipId !== null && isClipKnown(restoredClipId)
      ? restoredClipId
      : null;
  const amountField = checkVjMixFields(
    { amount: value.amount },
    { isComplete: false },
  );
  const blendField = checkVjMixFields(
    { blendMode: value.blendMode },
    { isComplete: false },
  );
  return {
    clipId,
    amount:
      clipId === null
        ? 0
        : amountField.failure === null && amountField.value.amount !== undefined
          ? amountField.value.amount
          : defaults.amount,
    blendMode:
      blendField.failure === null && blendField.value.blendMode !== undefined
        ? blendField.value.blendMode
        : defaults.blendMode,
  };
}
