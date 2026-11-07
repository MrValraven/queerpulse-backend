/**
 * The look commands of `/vj` (contract 7.5 and 7.6): transition, overlay,
 * countdown, logo, event card and reset look, plus their restore readers
 * (contract 7.13). Pure functions over the state, the payload and the rule
 * context; the stage service lands what they accept (contract 7.4).
 */
import {
  VJ_EVENT_CARD_KINDS,
  VJ_LIMITS,
  VJ_LOGO_CORNERS,
  VJ_OVERLAY_POSITIONS,
  VJ_OVERLAY_SIZES,
  VJ_OVERLAY_STYLES,
  VJ_COLOR_TOKENS,
} from '../vj.contract';
import type {
  VjColorToken,
  VjCountdown,
  VjEventCard,
  VjEventCardKind,
  VjLogo,
  VjLogoCorner,
  VjOverlay,
  VjOverlayPosition,
  VjOverlaySize,
  VjOverlayStyle,
  VjRemoteCommandName,
  VjSocketErrorCode,
  VjStageState,
  VjTransition,
} from '../vj.contract';
import {
  checkVjOverlayFields,
  checkVjOverlayText,
  checkVjTransitionFields,
} from '../vj-field-checks';
import {
  acceptRule,
  hasAnyField,
  hasControlCharacter,
  isOneOf,
  isRecord,
  isSafeIntegerInRange,
  readVjImmediateFlag,
  refuseRule,
  type VjCommandLookup,
  type VjCommandRuleResult,
  type VjRuleContext,
} from './vj-rule-kit';

/** The patch fields of each look command; a payload with none answers vj_patch_empty. */
const TRANSITION_FIELDS = ['mode', 'length'] as const;
const OVERLAY_FIELDS = [
  'text',
  'style',
  'isVisible',
  'position',
  'size',
  'colorToken',
  'hideAfterMs',
] as const;
const COUNTDOWN_FIELDS = [
  'isVisible',
  'targetAt',
  'durationMs',
  'label',
] as const;
const LOGO_FIELDS = ['isVisible', 'corner'] as const;
const EVENT_CARD_FIELDS = ['isVisible', 'kind'] as const;

/** The `isImmediate` reader's refusal, or null when the flag is fine (note 19: it runs after every field rule). */
function immediateRefusalOf(
  name: VjRemoteCommandName,
  payload: Record<string, unknown>,
): VjCommandRuleResult | null {
  const immediate = readVjImmediateFlag(name, payload);
  return immediate.code === null ? null : refuseRule(immediate.code);
}

/** `stage:setTransition`: mode, then the length (contract 7.5). */
export function ruleSetTransition(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (!hasAnyField(payload, TRANSITION_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const fieldCheck = checkVjTransitionFields(payload, { isComplete: false });
  if (fieldCheck.failure !== null) {
    return refuseRule(fieldCheck.failure.code);
  }
  const immediateRefusal = immediateRefusalOf('stage:setTransition', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  return acceptRule({
    ...state,
    transition: { ...state.transition, ...fieldCheck.value },
  });
}

/** Whether `hideAfterMs` is absent, null, or an integer 1000..600000. */
function isOverlayHideAfterMsValid(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    isSafeIntegerInRange(
      value,
      VJ_LIMITS.overlayHideAfterMsMin,
      VJ_LIMITS.overlayHideAfterMsMax,
    )
  );
}

/** `stage:setOverlay`: the field rules, `hideAfterMs`, then the blank text
 *  check. A hidden result hands back `overlayHideAfterMs: null`; a visible one
 *  hands back the sent `hideAfterMs` (a number, null, or undefined when absent). */
export function ruleSetOverlay(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (!hasAnyField(payload, OVERLAY_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const fieldCheck = checkVjOverlayFields(payload, { isComplete: false });
  if (fieldCheck.failure !== null) {
    return refuseRule(fieldCheck.failure.code);
  }
  if (!isOverlayHideAfterMsValid(payload.hideAfterMs)) {
    return refuseRule('vj_overlay_hide_out_of_range');
  }
  const overlay: VjOverlay = { ...state.overlay, ...fieldCheck.value };
  if (overlay.isVisible && overlay.text === '') {
    return refuseRule('vj_overlay_text_blank');
  }
  const immediateRefusal = immediateRefusalOf('stage:setOverlay', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  if (!overlay.isVisible) {
    return acceptRule(
      { ...state, overlay: { ...overlay, hideAt: null } },
      { overlayHideAfterMs: null },
    );
  }
  return acceptRule(
    { ...state, overlay },
    { overlayHideAfterMs: payload.hideAfterMs as number | null | undefined },
  );
}

/** A countdown label trimmed, or the code that refuses it. The control
 *  character check reads the label as sent, so a leading or trailing line
 *  break is refused before the trim could drop it. */
function checkCountdownLabel(
  value: unknown,
): { code: VjSocketErrorCode; label: null } | { code: null; label: string } {
  if (typeof value !== 'string' || hasControlCharacter(value)) {
    return { code: 'vj_countdown_label_invalid', label: null };
  }
  const label = value.trim();
  if (Array.from(label).length > VJ_LIMITS.countdownLabelMax) {
    return { code: 'vj_countdown_label_too_long', label: null };
  }
  return { code: null, label };
}

/** The countdown target a payload sets: `targetAt` as sent, `now + durationMs`,
 *  or undefined when it sends neither; the code when either is out of range. */
function readCountdownTarget(
  payload: Record<string, unknown>,
  now: number,
):
  | { code: VjSocketErrorCode; targetAt: undefined }
  | { code: null; targetAt: number | undefined } {
  if (payload.targetAt !== undefined) {
    return isSafeIntegerInRange(
      payload.targetAt,
      now + VJ_LIMITS.countdownLeadMsMin,
      now + VJ_LIMITS.countdownLeadMsMax,
    )
      ? { code: null, targetAt: payload.targetAt }
      : { code: 'vj_countdown_out_of_range', targetAt: undefined };
  }
  if (payload.durationMs !== undefined) {
    return isSafeIntegerInRange(
      payload.durationMs,
      VJ_LIMITS.countdownLeadMsMin,
      VJ_LIMITS.countdownLeadMsMax,
    )
      ? { code: null, targetAt: now + payload.durationMs }
      : { code: 'vj_countdown_out_of_range', targetAt: undefined };
  }
  return { code: null, targetAt: undefined };
}

/** `stage:setCountdown`: target conflict, target range, label, `isVisible`,
 *  then a visible result needs a future target (contract 7.5). */
export function ruleSetCountdown(
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  if (!hasAnyField(payload, COUNTDOWN_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  if (payload.targetAt !== undefined && payload.durationMs !== undefined) {
    return refuseRule('vj_countdown_target_conflict');
  }
  const target = readCountdownTarget(payload, context.now);
  if (target.code !== null) {
    return refuseRule(target.code);
  }
  const countdown: VjCountdown = { ...state.countdown };
  if (target.targetAt !== undefined) {
    countdown.targetAt = target.targetAt;
  }
  if (payload.label !== undefined) {
    const labelCheck = checkCountdownLabel(payload.label);
    if (labelCheck.code !== null) {
      return refuseRule(labelCheck.code);
    }
    countdown.label = labelCheck.label;
  }
  if (payload.isVisible !== undefined) {
    if (typeof payload.isVisible !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    countdown.isVisible = payload.isVisible;
  }
  if (
    countdown.isVisible &&
    (countdown.targetAt === null || countdown.targetAt <= context.now)
  ) {
    return refuseRule('vj_countdown_target_missing');
  }
  const immediateRefusal = immediateRefusalOf('stage:setCountdown', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  return acceptRule({ ...state, countdown });
}

/** `stage:setLogo`: `isVisible`, then the corner (contract 7.5). */
export function ruleSetLogo(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (!hasAnyField(payload, LOGO_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const logo: VjLogo = { ...state.logo };
  if (payload.isVisible !== undefined) {
    if (typeof payload.isVisible !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    logo.isVisible = payload.isVisible;
  }
  if (payload.corner !== undefined) {
    if (!isOneOf<VjLogoCorner>(VJ_LOGO_CORNERS, payload.corner)) {
      return refuseRule('vj_logo_corner_invalid');
    }
    logo.corner = payload.corner;
  }
  const immediateRefusal = immediateRefusalOf('stage:setLogo', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  return acceptRule({ ...state, logo });
}

/** `stage:setEventCard`: `isVisible`, the kind, then a visible result needs
 *  the active pack to link an event. Only a visible result reads the pack
 *  (note 21); with no active pack it answers before any read. */
export function ruleSetEventCard(
  state: VjStageState,
  payload: Record<string, unknown>,
  context: VjRuleContext,
): VjCommandRuleResult {
  if (!hasAnyField(payload, EVENT_CARD_FIELDS)) {
    return refuseRule('vj_patch_empty');
  }
  const eventCard: VjEventCard = { ...state.eventCard };
  if (payload.isVisible !== undefined) {
    if (typeof payload.isVisible !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    eventCard.isVisible = payload.isVisible;
  }
  if (payload.kind !== undefined) {
    if (!isOneOf<VjEventCardKind>(VJ_EVENT_CARD_KINDS, payload.kind)) {
      return refuseRule('vj_event_card_kind_invalid');
    }
    eventCard.kind = payload.kind;
  }
  const immediateRefusal = immediateRefusalOf('stage:setEventCard', payload);
  if (immediateRefusal !== null) {
    return immediateRefusal;
  }
  const nextState: VjStageState = { ...state, eventCard };
  if (!eventCard.isVisible) {
    return acceptRule(nextState);
  }
  if (state.activePackId === null) {
    return refuseRule('vj_event_card_no_event');
  }
  const packId = state.activePackId.toLowerCase();
  const lookups: VjCommandLookup[] = [{ kind: 'pack', packId }];
  if (context.lookups !== null) {
    const pack = context.lookups.packs.get(packId) ?? null;
    if (pack === null || pack.eventId === null) {
      return refuseRule('vj_event_card_no_event');
    }
  }
  return acceptRule(nextState, { lookups });
}

/** `stage:resetLook` (contract 7.6): clears exactly the listed fields and keeps
 *  everything else, blackout and screen overrides included. Accepts
 *  `isImmediate`; a stage with nothing to clear lands as the service's noop. */
export function ruleResetLook(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  const immediate = readVjImmediateFlag('stage:resetLook', payload);
  if (immediate.code !== null) {
    return refuseRule(immediate.code);
  }
  return acceptRule(
    {
      ...state,
      effects: {
        ...state.effects,
        settings: {},
        speed: 1,
        isStrobing: false,
        strobeStartedAt: null,
      },
      overlay: { ...state.overlay, isVisible: false, hideAt: null },
      countdown: { ...state.countdown, isVisible: false },
      logo: { ...state.logo, isVisible: false },
      eventCard: { ...state.eventCard, isVisible: false },
      mix: { clipId: null, amount: 0, blendMode: 'normal' },
    },
    { isImmediate: immediate.isImmediate, overlayHideAfterMs: null },
  );
}

/** A restored transition: each field checked with the command rules alone;
 *  a bad one takes its default. */
export function restoredVjTransition(
  value: unknown,
  defaults: VjTransition,
): VjTransition {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const modeCheck = checkVjTransitionFields(
    { mode: source.mode },
    { isComplete: false },
  );
  const lengthCheck = checkVjTransitionFields(
    { length: source.length },
    { isComplete: false },
  );
  return {
    mode: modeCheck.value?.mode ?? defaults.mode,
    length: lengthCheck.value?.length ?? defaults.length,
  };
}

/** A restored listed field: the value when the list has it, else the default. */
function restoredListValue<Value>(
  list: readonly Value[],
  value: unknown,
  fallback: Value,
): Value {
  return isOneOf<Value>(list, value) ? value : fallback;
}

/** A restored overlay hide time: null when unset or not an integer; capped at
 *  the longest auto-hide from now so no timer reaches past it. */
function restoredOverlayHideAt(value: unknown, now: number): number | null {
  if (!isSafeIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Math.min(value, now + VJ_LIMITS.overlayHideAfterMsMax);
}

/** A restored overlay (contract 7.13): each field checked alone, a bad one
 *  takes its default. A visible overlay with blank text, or a `hideAt` at or
 *  before `now`, comes back hidden with `hideAt: null`. */
export function restoredVjOverlay(
  value: unknown,
  defaults: VjOverlay,
  now: number,
): VjOverlay {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const textCheck = checkVjOverlayText(source.text);
  const text = textCheck.failure === null ? textCheck.value : defaults.text;
  const hideAt = restoredOverlayHideAt(source.hideAt, now);
  const isVisible =
    (typeof source.isVisible === 'boolean'
      ? source.isVisible
      : defaults.isVisible) &&
    text !== '' &&
    (hideAt === null || hideAt > now);
  return {
    text,
    style: restoredListValue<VjOverlayStyle>(
      VJ_OVERLAY_STYLES,
      source.style,
      defaults.style,
    ),
    isVisible,
    position: restoredListValue<VjOverlayPosition>(
      VJ_OVERLAY_POSITIONS,
      source.position,
      defaults.position,
    ),
    size: restoredListValue<VjOverlaySize>(
      VJ_OVERLAY_SIZES,
      source.size,
      defaults.size,
    ),
    colorToken: restoredListValue<VjColorToken>(
      VJ_COLOR_TOKENS,
      source.colorToken,
      defaults.colorToken,
    ),
    hideAt: isVisible ? hideAt : null,
  };
}

/** A restored countdown (contract 7.13): a target past 24 h from now or not
 *  an integer takes the default; the label follows the command rules; it shows
 *  only while `targetAt + countdownHoldMs` is after `now`. */
export function restoredVjCountdown(
  value: unknown,
  defaults: VjCountdown,
  now: number,
): VjCountdown {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const targetAt = isSafeIntegerInRange(
    source.targetAt,
    0,
    now + VJ_LIMITS.countdownLeadMsMax,
  )
    ? source.targetAt
    : defaults.targetAt;
  const labelCheck = checkCountdownLabel(source.label);
  const isVisibleSent =
    typeof source.isVisible === 'boolean'
      ? source.isVisible
      : defaults.isVisible;
  return {
    isVisible:
      isVisibleSent &&
      targetAt !== null &&
      targetAt + VJ_LIMITS.countdownHoldMs > now,
    targetAt,
    label: labelCheck.code === null ? labelCheck.label : defaults.label,
  };
}

/** A restored logo: each field checked alone, a bad one takes its default. */
export function restoredVjLogo(value: unknown, defaults: VjLogo): VjLogo {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    isVisible:
      typeof source.isVisible === 'boolean'
        ? source.isVisible
        : defaults.isVisible,
    corner: restoredListValue<VjLogoCorner>(
      VJ_LOGO_CORNERS,
      source.corner,
      defaults.corner,
    ),
  };
}

/** A restored event card (contract 7.13): it shows only when the restored
 *  pack links an event. */
export function restoredVjEventCard(
  value: unknown,
  defaults: VjEventCard,
  hasLinkedEvent: boolean,
): VjEventCard {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const isVisibleSent =
    typeof source.isVisible === 'boolean'
      ? source.isVisible
      : defaults.isVisible;
  return {
    isVisible: isVisibleSent && hasLinkedEvent,
    kind: restoredListValue<VjEventCardKind>(
      VJ_EVENT_CARD_KINDS,
      source.kind,
      defaults.kind,
    ),
  };
}
