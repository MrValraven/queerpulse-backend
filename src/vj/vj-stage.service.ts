import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { vjAckFailure } from './vj.constants';
import {
  createVjStageState,
  VJ_CLIP_READY_STATES,
  VJ_LIMITS,
  VJ_OVERLAY_STYLES,
  VJ_PRELOAD_FAILURES,
  VJ_SHUFFLE_BEAT_COUNTS,
  VJ_SHUFFLE_INTERVAL_KINDS,
  VJ_SPEEDS,
  VJ_TRANSITION_MODES,
  type VjAckFailure,
  type VjClipReadyState,
  type VjCommandSuccess,
  type VjEffects,
  type VjLibraryChange,
  type VjOverlay,
  type VjOverlayStyle,
  type VjPreloadFailure,
  type VjRemoteCommandName,
  type VjScreenClipStatus,
  type VjScreenPreload,
  type VjScreenStatus,
  type VjShuffle,
  type VjShuffleIntervalKind,
  type VjSocketErrorCode,
  type VjSpeed,
  type VjStageCause,
  type VjStageFrame,
  type VjStageState,
  type VjTransition,
  type VjTransitionMode,
} from './vj.contract';

export type { VjRemoteCommandName } from './vj.contract';

/** How long a disconnected screen stays in the list as offline (contract 6.7). */
export const VJ_SCREEN_OFFLINE_RETENTION_MS = 600_000;

/** How long a stage with no attached socket lives before the sweep drops it
 *  (contract 6.13). */
export const VJ_STAGE_IDLE_EVICTION_MS = 21_600_000;

/** Most client ids whose last command sequence one stage remembers; the least
 *  recently used one is forgotten first (contract 6.5). */
export const VJ_CLIENT_SEQUENCE_MEMORY = 32;

/** Most clip entries kept from one `screen:status` report (contract 6.6). */
const SCREEN_STATUS_CLIPS_MAX = 200;

/** Where the gateway hands a frame the service produced on its own clock
 *  (the strobe timeout) to the stage room. */
export interface VjStageBroadcaster {
  broadcastState(adminUserId: string, frame: VjStageFrame): void;
}

/** A lead change another socket must hear about: the socket that now leads,
 *  or null when no screen is connected. */
export interface VjLeadChange {
  promotedSocketId: string | null;
}

/** The answer of a stage command: the success ack and the frame to broadcast
 *  (null on a noop), or the refusal ack. */
export type VjStageOutcome =
  | { ok: true; success: VjCommandSuccess; frame: VjStageFrame | null }
  | { ok: false; failure: VjAckFailure };

/** The answer of a screen attach. `leadChange` is set only when a socket other
 *  than the attaching one now leads (the attaching socket learns its role
 *  from `isLead`). */
export type VjScreenAttachOutcome =
  | {
      ok: true;
      state: VjStageState;
      isRestored: boolean;
      isLead: boolean;
      replacedSocketId: string | null;
      leadChange: VjLeadChange | null;
    }
  | { ok: false; failure: VjAckFailure };

/** The one existence read a remote command needs before it applies. */
export type VjCommandLookup = { kind: 'pack' | 'clip'; id: string } | null;

/** One screen of a stage, keyed by its `screenId`. */
interface VjScreenEntry {
  screenId: string;
  number: number;
  /** The socket attached now; null while the screen is offline. */
  socketId: string | null;
  isFullscreen: boolean;
  connectedAt: number | null;
  /** Grows with every attach in the stage; breaks a `connectedAt` tie. */
  connectionOrder: number;
  disconnectedAt: number | null;
  lastSeenAt: number;
  preload: VjScreenPreload;
}

/** Everything the service keeps for one admin's stage. */
interface VjStage {
  adminUserId: string;
  state: VjStageState;
  screens: Map<string, VjScreenEntry>;
  highestScreenNumber: number;
  connectionCounter: number;
  /** Last sequence per client id, re-inserted on use for LRU order. */
  clientSequences: Map<string, number>;
  attachedSocketIds: Set<string>;
  idleSince: number | null;
  strobeTimer: NodeJS.Timeout | null;
}

/** What a remote command's field rules answer. */
type VjCommandRuleResult =
  | { failure: VjAckFailure; nextState: null; lookup: null }
  | { failure: null; nextState: VjStageState; lookup: VjCommandLookup };

/** What the client id and stale checks answer. */
type VjClientCheck =
  | { failure: VjAckFailure; clientId: null; commandSequence: null }
  | { failure: null; clientId: string; commandSequence: number };

/** What the advance checks answer. */
type VjAdvanceCheck =
  | { failure: VjAckFailure; packId: null; clipId: null }
  | { failure: null; packId: string; clipId: string };

type VjAppliedOutcome = Extract<VjStageOutcome, { ok: true }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

/** A uuid lowercased or null, with `isValid` false for anything else. */
function readNullableUuid(
  value: unknown,
): { isValid: true; id: string | null } | { isValid: false; id: null } {
  if (value === null) {
    return { isValid: true, id: null };
  }
  if (isUuidString(value)) {
    return { isValid: true, id: value.toLowerCase() };
  }
  return { isValid: false, id: null };
}

function isOneOf<Value>(
  list: readonly Value[],
  value: unknown,
): value is Value {
  return (list as readonly unknown[]).includes(value);
}

function refuseRule(code: VjSocketErrorCode): VjCommandRuleResult {
  return { failure: vjAckFailure(code), nextState: null, lookup: null };
}

function acceptRule(
  nextState: VjStageState,
  lookup: VjCommandLookup = null,
): VjCommandRuleResult {
  return { failure: null, nextState, lookup };
}

function hasAnyField(
  payload: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => payload[field] !== undefined);
}

function isFadeMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= VJ_LIMITS.fadeMsMin &&
    value <= VJ_LIMITS.fadeMsMax
  );
}

/** U+0000..U+001F, U+007F..U+009F, U+2028 and U+2029 (contract 6.6). */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

/** Trims overlay text and answers the first rule it breaks, if any. */
function checkOverlayText(
  value: unknown,
): { code: VjSocketErrorCode; text: null } | { code: null; text: string } {
  if (typeof value !== 'string') {
    return { code: 'vj_overlay_text_invalid', text: null };
  }
  const text = value.trim();
  if (hasControlCharacter(text)) {
    return { code: 'vj_overlay_text_invalid', text: null };
  }
  if (Array.from(text).length > VJ_LIMITS.overlayTextMax) {
    return { code: 'vj_overlay_text_too_long', text: null };
  }
  return { code: null, text };
}

function isShuffleIntervalValid(
  kind: VjShuffleIntervalKind,
  value: unknown,
): value is number {
  if (typeof value !== 'number') {
    return false;
  }
  if (kind === 'beats') {
    return isOneOf(VJ_SHUFFLE_BEAT_COUNTS, value);
  }
  return (
    Number.isInteger(value) &&
    value >= VJ_LIMITS.shuffleSecondsMin &&
    value <= VJ_LIMITS.shuffleSecondsMax
  );
}

function isBpmInRange(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= VJ_LIMITS.bpmMin &&
    value <= VJ_LIMITS.bpmMax
  );
}

/** Rounds a tempo to one decimal place. */
function roundBpm(bpm: number): number {
  return Math.round(bpm * 10) / 10;
}

function ruleSetPack(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  const packRead = readNullableUuid(payload.packId);
  if (!packRead.isValid) {
    return refuseRule('vj_pack_not_found');
  }
  const packId = packRead.id;
  const lookup: VjCommandLookup =
    packId === null ? null : { kind: 'pack', id: packId };
  if (packId === state.activePackId) {
    return acceptRule(state, lookup);
  }
  return acceptRule(
    {
      ...state,
      activePackId: packId,
      clipSequence: state.clipSequence + 1,
    },
    lookup,
  );
}

/** A re-tap of the live clip is never a noop: the sequence always grows. */
function ruleGoClip(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  const clipRead = readNullableUuid(payload.clipId);
  if (!clipRead.isValid) {
    return refuseRule('vj_clip_not_found');
  }
  const clipId = clipRead.id;
  return acceptRule(
    { ...state, liveClipId: clipId, clipSequence: state.clipSequence + 1 },
    clipId === null ? null : { kind: 'clip', id: clipId },
  );
}

function ruleSetTransition(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (!hasAnyField(payload, ['mode', 'fadeMs'])) {
    return refuseRule('vj_patch_empty');
  }
  const transition: VjTransition = { ...state.transition };
  if (payload.mode !== undefined) {
    if (!isOneOf<VjTransitionMode>(VJ_TRANSITION_MODES, payload.mode)) {
      return refuseRule('vj_transition_mode_invalid');
    }
    transition.mode = payload.mode;
  }
  if (payload.fadeMs !== undefined) {
    if (!isFadeMs(payload.fadeMs)) {
      return refuseRule('vj_fade_out_of_range');
    }
    transition.fadeMs = payload.fadeMs;
  }
  return acceptRule({ ...state, transition });
}

function ruleSetOverlay(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (!hasAnyField(payload, ['text', 'style', 'isVisible'])) {
    return refuseRule('vj_patch_empty');
  }
  const overlay: VjOverlay = { ...state.overlay };
  if (payload.text !== undefined) {
    const textCheck = checkOverlayText(payload.text);
    if (textCheck.code !== null) {
      return refuseRule(textCheck.code);
    }
    overlay.text = textCheck.text;
  }
  if (payload.style !== undefined) {
    if (!isOneOf<VjOverlayStyle>(VJ_OVERLAY_STYLES, payload.style)) {
      return refuseRule('vj_overlay_style_invalid');
    }
    overlay.style = payload.style;
  }
  if (payload.isVisible !== undefined) {
    if (typeof payload.isVisible !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    overlay.isVisible = payload.isVisible;
  }
  if (overlay.isVisible && overlay.text === '') {
    return refuseRule('vj_overlay_text_blank');
  }
  return acceptRule({ ...state, overlay });
}

/** The effect switches a `stage:setEffects` patch may carry. */
const EFFECT_FLAG_FIELDS = [
  'isMonochrome',
  'isMirrored',
  'isHueCycling',
  'isBlackout',
] as const;

function ruleSetEffects(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (!hasAnyField(payload, ['speed', ...EFFECT_FLAG_FIELDS])) {
    return refuseRule('vj_patch_empty');
  }
  const effects: VjEffects = { ...state.effects };
  if (payload.speed !== undefined) {
    if (!isOneOf<VjSpeed>(VJ_SPEEDS, payload.speed)) {
      return refuseRule('vj_speed_invalid');
    }
    effects.speed = payload.speed;
  }
  for (const flagField of EFFECT_FLAG_FIELDS) {
    const flagValue = payload[flagField];
    if (flagValue === undefined) {
      continue;
    }
    if (typeof flagValue !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    effects[flagField] = flagValue;
  }
  return acceptRule({ ...state, effects });
}

/** `strobeStartedAt` is stamped by `applyPatch`, which knows `now`. */
function ruleSetStrobe(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  if (typeof payload.isStrobing !== 'boolean') {
    return refuseRule('vj_effect_flag_invalid');
  }
  return acceptRule({
    ...state,
    effects: { ...state.effects, isStrobing: payload.isStrobing },
  });
}

function ruleSetShuffle(
  state: VjStageState,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  const fields = ['isOn', 'intervalKind', 'intervalValue', 'bpm'];
  if (!hasAnyField(payload, fields)) {
    return refuseRule('vj_patch_empty');
  }
  const shuffle: VjShuffle = { ...state.shuffle };
  if (payload.isOn !== undefined) {
    if (typeof payload.isOn !== 'boolean') {
      return refuseRule('vj_effect_flag_invalid');
    }
    shuffle.isOn = payload.isOn;
  }
  if (payload.intervalKind !== undefined) {
    if (
      !isOneOf<VjShuffleIntervalKind>(
        VJ_SHUFFLE_INTERVAL_KINDS,
        payload.intervalKind,
      )
    ) {
      return refuseRule('vj_shuffle_interval_invalid');
    }
    shuffle.intervalKind = payload.intervalKind;
  }
  const intervalValue: unknown =
    payload.intervalValue !== undefined
      ? payload.intervalValue
      : isShuffleIntervalValid(shuffle.intervalKind, shuffle.intervalValue)
        ? shuffle.intervalValue
        : VJ_LIMITS.shuffleSecondsDefault;
  if (!isShuffleIntervalValid(shuffle.intervalKind, intervalValue)) {
    return refuseRule('vj_shuffle_interval_invalid');
  }
  shuffle.intervalValue = intervalValue;
  if (payload.bpm !== undefined) {
    if (!isBpmInRange(payload.bpm)) {
      return refuseRule('vj_bpm_out_of_range');
    }
    shuffle.bpm = roundBpm(payload.bpm);
  }
  return acceptRule({ ...state, shuffle });
}

/** Runs the field rules of one remote command against the current state. */
function ruleForCommand(
  state: VjStageState,
  name: VjRemoteCommandName,
  payload: Record<string, unknown>,
): VjCommandRuleResult {
  switch (name) {
    case 'stage:setPack':
      return ruleSetPack(state, payload);
    case 'stage:goClip':
      return ruleGoClip(state, payload);
    case 'stage:setTransition':
      return ruleSetTransition(state, payload);
    case 'stage:setOverlay':
      return ruleSetOverlay(state, payload);
    case 'stage:setEffects':
      return ruleSetEffects(state, payload);
    case 'stage:setStrobe':
      return ruleSetStrobe(state, payload);
    case 'stage:setShuffle':
      return ruleSetShuffle(state, payload);
  }
}

/** Keeps `strobeStartedAt` in step with `isStrobing`: stamped when it goes on,
 *  kept while it stays on (the 10 s are never extended), cleared when off. */
function withStrobeStamp(
  previous: VjStageState,
  proposed: VjStageState,
  now: number,
): VjStageState {
  const strobeStartedAt = !proposed.effects.isStrobing
    ? null
    : previous.effects.isStrobing
      ? previous.effects.strobeStartedAt
      : now;
  if (strobeStartedAt === proposed.effects.strobeStartedAt) {
    return proposed;
  }
  return { ...proposed, effects: { ...proposed.effects, strobeStartedAt } };
}

/** Whether two states show the same thing; `revision` and `updatedAt` aside. */
function isSameStageContent(
  first: VjStageState,
  second: VjStageState,
): boolean {
  return (
    first.stageEpoch === second.stageEpoch &&
    first.clipSequence === second.clipSequence &&
    first.activePackId === second.activePackId &&
    first.liveClipId === second.liveClipId &&
    first.transition.mode === second.transition.mode &&
    first.transition.fadeMs === second.transition.fadeMs &&
    first.overlay.text === second.overlay.text &&
    first.overlay.style === second.overlay.style &&
    first.overlay.isVisible === second.overlay.isVisible &&
    first.effects.speed === second.effects.speed &&
    first.effects.isMonochrome === second.effects.isMonochrome &&
    first.effects.isMirrored === second.effects.isMirrored &&
    first.effects.isHueCycling === second.effects.isHueCycling &&
    first.effects.isStrobing === second.effects.isStrobing &&
    first.effects.isBlackout === second.effects.isBlackout &&
    first.effects.strobeStartedAt === second.effects.strobeStartedAt &&
    first.shuffle.isOn === second.shuffle.isOn &&
    first.shuffle.intervalKind === second.shuffle.intervalKind &&
    first.shuffle.intervalValue === second.shuffle.intervalValue &&
    first.shuffle.bpm === second.shuffle.bpm
  );
}

/** The uuid-shaped pack and clip ids of a restore payload, lowercased. */
function restoreIdsOf(restoreState: unknown): {
  packId: string | null;
  clipId: string | null;
} {
  if (!isRecord(restoreState)) {
    return { packId: null, clipId: null };
  }
  const { activePackId, liveClipId } = restoreState;
  return {
    packId: isUuidString(activePackId) ? activePackId.toLowerCase() : null,
    clipId: isUuidString(liveClipId) ? liveClipId.toLowerCase() : null,
  };
}

function restoredTransition(
  value: unknown,
  defaults: VjTransition,
): VjTransition {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    mode: isOneOf<VjTransitionMode>(VJ_TRANSITION_MODES, source.mode)
      ? source.mode
      : defaults.mode,
    fadeMs: isFadeMs(source.fadeMs) ? source.fadeMs : defaults.fadeMs,
  };
}

/** A field that fails takes its default; a visible overlay left with blank
 *  text is hidden. */
function restoredOverlay(value: unknown, defaults: VjOverlay): VjOverlay {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const textCheck = checkOverlayText(source.text);
  const text = textCheck.code === null ? textCheck.text : defaults.text;
  const isVisible =
    typeof source.isVisible === 'boolean' ? source.isVisible : false;
  return {
    text,
    style: isOneOf<VjOverlayStyle>(VJ_OVERLAY_STYLES, source.style)
      ? source.style
      : defaults.style,
    isVisible: isVisible && text !== '',
  };
}

/** The strobe always comes back off. */
function restoredEffects(value: unknown, defaults: VjEffects): VjEffects {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const flagOf = (field: (typeof EFFECT_FLAG_FIELDS)[number]): boolean => {
    const flagValue = source[field];
    return typeof flagValue === 'boolean' ? flagValue : defaults[field];
  };
  return {
    speed: isOneOf<VjSpeed>(VJ_SPEEDS, source.speed)
      ? source.speed
      : defaults.speed,
    isMonochrome: flagOf('isMonochrome'),
    isMirrored: flagOf('isMirrored'),
    isHueCycling: flagOf('isHueCycling'),
    isStrobing: false,
    isBlackout: flagOf('isBlackout'),
    strobeStartedAt: null,
  };
}

function restoredShuffle(value: unknown, defaults: VjShuffle): VjShuffle {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const intervalKind = isOneOf<VjShuffleIntervalKind>(
    VJ_SHUFFLE_INTERVAL_KINDS,
    source.intervalKind,
  )
    ? source.intervalKind
    : defaults.intervalKind;
  return {
    isOn: typeof source.isOn === 'boolean' ? source.isOn : defaults.isOn,
    intervalKind,
    intervalValue: isShuffleIntervalValid(intervalKind, source.intervalValue)
      ? source.intervalValue
      : VJ_LIMITS.shuffleSecondsDefault,
    bpm: isBpmInRange(source.bpm) ? roundBpm(source.bpm) : defaults.bpm,
  };
}

/** The state a lost stage takes from a screen's saved copy (contract 6.4):
 *  every field checked with the command rules, ids the gateway could not find
 *  dropped, the server's epoch kept, revision and clip sequence at 1. */
function restoredStageState(
  base: VjStageState,
  restoreState: Record<string, unknown>,
  lookups: { isActivePackKnown: boolean; isLiveClipKnown: boolean },
  now: number,
): VjStageState {
  const defaults = createVjStageState(base.stageEpoch, now);
  const ids = restoreIdsOf(restoreState);
  return {
    ...defaults,
    revision: 1,
    clipSequence: 1,
    activePackId: lookups.isActivePackKnown ? ids.packId : null,
    liveClipId: lookups.isLiveClipKnown ? ids.clipId : null,
    transition: restoredTransition(
      restoreState.transition,
      defaults.transition,
    ),
    overlay: restoredOverlay(restoreState.overlay, defaults.overlay),
    effects: restoredEffects(restoreState.effects, defaults.effects),
    shuffle: restoredShuffle(restoreState.shuffle, defaults.shuffle),
  };
}

/** The state a library change leaves a stage in, or null when it does not
 *  touch the stage (contract 6.10). */
function libraryChangeState(
  state: VjStageState,
  change: VjLibraryChange,
): VjStageState | null {
  if (
    change.kind === 'pack_deleted' &&
    state.activePackId !== null &&
    change.packId?.toLowerCase() === state.activePackId
  ) {
    return {
      ...state,
      activePackId: null,
      shuffle: { ...state.shuffle, isOn: false },
      clipSequence: state.clipSequence + 1,
    };
  }
  if (
    change.kind === 'clip_deleted' &&
    state.liveClipId !== null &&
    change.clipId?.toLowerCase() === state.liveClipId
  ) {
    return {
      ...state,
      liveClipId: null,
      clipSequence: state.clipSequence + 1,
    };
  }
  return null;
}

function parseClipStatus(value: unknown): VjScreenClipStatus | null {
  if (!isRecord(value) || !isUuidString(value.clipId)) {
    return null;
  }
  if (!isOneOf<VjClipReadyState>(VJ_CLIP_READY_STATES, value.state)) {
    return null;
  }
  const { progress } = value;
  if (
    typeof progress !== 'number' ||
    !Number.isFinite(progress) ||
    progress < 0 ||
    progress > 1
  ) {
    return null;
  }
  const rawFailure = value.failure ?? null;
  let failure: VjPreloadFailure | null = null;
  if (rawFailure !== null) {
    if (!isOneOf<VjPreloadFailure>(VJ_PRELOAD_FAILURES, rawFailure)) {
      return null;
    }
    failure = rawFailure;
  }
  return {
    clipId: value.clipId.toLowerCase(),
    state: value.state,
    progress,
    failure: value.state === 'failed' ? failure : null,
  };
}

/** A fresh copy of a well-formed `screen:status` payload, the clip list cut
 *  to 200 entries, or null when any part is malformed. */
function parseScreenStatus(
  payload: Record<string, unknown>,
): { isFullscreen: boolean; preload: VjScreenPreload } | null {
  const { isFullscreen, preload } = payload;
  if (typeof isFullscreen !== 'boolean' || !isRecord(preload)) {
    return null;
  }
  const packRead = readNullableUuid(preload.packId);
  const { clips } = preload;
  if (!packRead.isValid || !Array.isArray(clips)) {
    return null;
  }
  const parsedClips: VjScreenClipStatus[] = [];
  for (const clip of clips.slice(0, SCREEN_STATUS_CLIPS_MAX)) {
    const parsedClip = parseClipStatus(clip);
    if (parsedClip === null) {
      return null;
    }
    parsedClips.push(parsedClip);
  }
  return {
    isFullscreen,
    preload: {
      packId: packRead.id,
      clips: parsedClips,
    },
  };
}

/** The connected screen with the earliest `connectedAt`, earliest attach first
 *  on a tie (contract 6.8). */
function leadEntryOf(stage: VjStage): VjScreenEntry | null {
  let lead: VjScreenEntry | null = null;
  for (const entry of stage.screens.values()) {
    if (entry.socketId === null || entry.connectedAt === null) {
      continue;
    }
    if (
      lead === null ||
      lead.connectedAt === null ||
      entry.connectedAt < lead.connectedAt ||
      (entry.connectedAt === lead.connectedAt &&
        entry.connectionOrder < lead.connectionOrder)
    ) {
      lead = entry;
    }
  }
  return lead;
}

function leadSocketIdOfStage(stage: VjStage): string | null {
  return leadEntryOf(stage)?.socketId ?? null;
}

function screenEntryOfSocket(
  stage: VjStage,
  socketId: string,
): VjScreenEntry | null {
  for (const entry of stage.screens.values()) {
    if (entry.socketId === socketId) {
      return entry;
    }
  }
  return null;
}

/** Drops screens offline for over `VJ_SCREEN_OFFLINE_RETENTION_MS` (note 12). */
function pruneOfflineScreens(stage: VjStage, now: number): void {
  for (const [screenId, entry] of stage.screens) {
    if (
      entry.socketId === null &&
      entry.disconnectedAt !== null &&
      now - entry.disconnectedAt > VJ_SCREEN_OFFLINE_RETENTION_MS
    ) {
      stage.screens.delete(screenId);
    }
  }
}

/** Remembers a client's last sequence, most recent last, forgetting the least
 *  recently used client past `VJ_CLIENT_SEQUENCE_MEMORY`. */
function recordClientSequence(
  stage: VjStage,
  clientId: string,
  commandSequence: number,
): void {
  stage.clientSequences.delete(clientId);
  stage.clientSequences.set(clientId, commandSequence);
  for (const knownClientId of stage.clientSequences.keys()) {
    if (stage.clientSequences.size <= VJ_CLIENT_SEQUENCE_MEMORY) {
      return;
    }
    stage.clientSequences.delete(knownClientId);
  }
}

/** The client id and stale checks every remote command runs first. */
function checkClientCommand(
  stage: VjStage,
  payload: Record<string, unknown>,
): VjClientCheck {
  const { clientId, commandSequence } = payload;
  if (
    !isUuidString(clientId) ||
    typeof commandSequence !== 'number' ||
    !Number.isSafeInteger(commandSequence) ||
    commandSequence < 1
  ) {
    return {
      failure: vjAckFailure('vj_client_id_invalid'),
      clientId: null,
      commandSequence: null,
    };
  }
  const lastSequence = stage.clientSequences.get(clientId);
  if (lastSequence !== undefined && commandSequence <= lastSequence) {
    return {
      failure: vjAckFailure('vj_stale_command', stage.state),
      clientId: null,
      commandSequence: null,
    };
  }
  return { failure: null, clientId, commandSequence };
}

function refuseAdvance(
  code: VjSocketErrorCode,
  state?: VjStageState,
): VjAdvanceCheck {
  return { failure: vjAckFailure(code, state), packId: null, clipId: null };
}

/** The `screen:advance` checks in contract order: lead, shuffle on, an active
 *  pack, the current clip sequence, then a uuid clip id. */
function checkAdvance(
  stage: VjStage,
  socketId: string,
  payload: Record<string, unknown>,
): VjAdvanceCheck {
  const { state } = stage;
  if (leadSocketIdOfStage(stage) !== socketId) {
    return refuseAdvance('vj_not_lead', state);
  }
  if (!state.shuffle.isOn) {
    return refuseAdvance('vj_shuffle_off', state);
  }
  if (state.activePackId === null) {
    return refuseAdvance('vj_no_active_pack', state);
  }
  const { expectedClipSequence, clipId } = payload;
  if (
    typeof expectedClipSequence !== 'number' ||
    !Number.isSafeInteger(expectedClipSequence) ||
    expectedClipSequence !== state.clipSequence
  ) {
    return refuseAdvance('vj_stale_clip_sequence', state);
  }
  if (!isUuidString(clipId)) {
    return refuseAdvance('vj_clip_not_in_pack');
  }
  return {
    failure: null,
    packId: state.activePackId,
    clipId: clipId.toLowerCase(),
  };
}

/**
 * The live VJ stages. One stage per admin user id, held in process memory
 * only: `chat/chat-single-instance.guard.ts` keeps the backend on one
 * replica, so every screen and remote of an admin reaches this map. Nothing
 * is written to the database and nothing is logged. The service touches no
 * socket: the gateway passes in the answers of its existence reads and fans
 * out the frames this service returns (contract 6.4 to 6.13).
 */
@Injectable()
export class VjStageService implements OnModuleDestroy {
  private readonly stages = new Map<string, VjStage>();
  private broadcaster: VjStageBroadcaster | null = null;

  /** Where strobe timeouts broadcast; the gateway binds itself on init. */
  bindBroadcaster(broadcaster: VjStageBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  /** The admin's stage state, or null when no stage is in memory. */
  getState(adminUserId: string): VjStageState | null {
    return this.stages.get(adminUserId)?.state ?? null;
  }

  /** Whether a screen's restore would be adopted now: no stage yet, or one at
   *  revision 0. The gateway reads the restore ids only then. */
  shouldAdoptRestore(adminUserId: string): boolean {
    const stage = this.stages.get(adminUserId);
    return stage === undefined || stage.state.revision === 0;
  }

  /** The uuid-shaped pack and clip ids a restore names, for the gateway's two
   *  existence reads. */
  restoreLookupIds(restoreState: unknown): {
    packId: string | null;
    clipId: string | null;
  } {
    return restoreIdsOf(restoreState);
  }

  /** Attaches a screen: creates the stage when there is none, adopts a
   *  restore at revision 0, reuses or numbers the screen entry, replaces an
   *  older socket of the same screen, and settles the lead. */
  attachScreen(
    input: {
      adminUserId: string;
      socketId: string;
      screenId: unknown;
      restoreState: unknown;
      restoreLookups: { isActivePackKnown: boolean; isLiveClipKnown: boolean };
    },
    now: number,
  ): VjScreenAttachOutcome {
    if (!isUuidString(input.screenId)) {
      return { ok: false, failure: vjAckFailure('vj_screen_id_invalid') };
    }
    const screenId = input.screenId.toLowerCase();
    const stage = this.ensureStage(input.adminUserId, now);
    let isRestored = false;
    if (stage.state.revision === 0 && isRecord(input.restoreState)) {
      stage.state = restoredStageState(
        stage.state,
        input.restoreState,
        input.restoreLookups,
        now,
      );
      isRestored = true;
    }
    const leadBefore = leadSocketIdOfStage(stage);
    const replacedSocketId = this.connectScreen(
      stage,
      screenId,
      input.socketId,
      now,
    );
    stage.attachedSocketIds.add(input.socketId);
    stage.idleSince = null;
    const leadAfter = leadSocketIdOfStage(stage);
    const leadChange =
      leadAfter !== leadBefore && leadAfter !== input.socketId
        ? { promotedSocketId: leadAfter }
        : null;
    return {
      ok: true,
      state: stage.state,
      isRestored,
      isLead: leadAfter === input.socketId,
      replacedSocketId,
      leadChange,
    };
  }

  /** Attaches a remote, creating the stage when there is none. */
  attachRemote(
    adminUserId: string,
    socketId: string,
    now: number,
  ): VjStageState {
    const stage = this.ensureStage(adminUserId, now);
    stage.attachedSocketIds.add(socketId);
    stage.idleSince = null;
    return stage.state;
  }

  /** Forgets a socket. A screen's entry goes offline and, when it led, the
   *  longest-connected screen is promoted. A socket another one already
   *  replaced changes nothing. */
  detachSocket(
    adminUserId: string,
    socketId: string,
    now: number,
  ): { leadChange: VjLeadChange | null; hasScreenListChanged: boolean } {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { leadChange: null, hasScreenListChanged: false };
    }
    const hasDetachedSocket = stage.attachedSocketIds.delete(socketId);
    if (hasDetachedSocket && stage.attachedSocketIds.size === 0) {
      stage.idleSince = now;
    }
    const entry = screenEntryOfSocket(stage, socketId);
    if (entry === null) {
      return { leadChange: null, hasScreenListChanged: false };
    }
    const leadBefore = leadSocketIdOfStage(stage);
    entry.socketId = null;
    entry.connectedAt = null;
    entry.disconnectedAt = now;
    const leadChange =
      leadBefore === socketId
        ? { promotedSocketId: leadSocketIdOfStage(stage) }
        : null;
    return { leadChange, hasScreenListChanged: true };
  }

  /** The client id, stale and field checks of a remote command, recording
   *  nothing, and the existence read it needs. A refusal here is not
   *  recorded: the caller answers it through `applyRemoteCommand`, which
   *  reruns the checks, records the sequence (note 9) and answers the same
   *  code. */
  prepareRemoteCommand(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
  ):
    | { failure: VjAckFailure; lookup: null }
    | { failure: null; lookup: VjCommandLookup } {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { failure: vjAckFailure('vj_not_attached'), lookup: null };
    }
    const clientCheck = checkClientCommand(stage, payload);
    if (clientCheck.failure !== null) {
      return { failure: clientCheck.failure, lookup: null };
    }
    const rule = ruleForCommand(stage.state, name, payload);
    if (rule.failure !== null) {
      return { failure: rule.failure, lookup: null };
    }
    return { failure: null, lookup: rule.lookup };
  }

  /** Reruns every check of a remote command, records its sequence on every
   *  outcome past the stale check, and applies it. */
  applyRemoteCommand(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
    isLookupKnown: boolean,
    now: number,
  ): VjStageOutcome {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { ok: false, failure: vjAckFailure('vj_not_attached') };
    }
    const clientCheck = checkClientCommand(stage, payload);
    if (clientCheck.failure !== null) {
      return { ok: false, failure: clientCheck.failure };
    }
    recordClientSequence(
      stage,
      clientCheck.clientId,
      clientCheck.commandSequence,
    );
    const rule = ruleForCommand(stage.state, name, payload);
    if (rule.failure !== null) {
      return { ok: false, failure: rule.failure };
    }
    if (rule.lookup !== null && !isLookupKnown) {
      const code =
        rule.lookup.kind === 'pack' ? 'vj_pack_not_found' : 'vj_clip_not_found';
      return { ok: false, failure: vjAckFailure(code) };
    }
    return this.applyPatch(
      stage,
      rule.nextState,
      'command',
      clientCheck.clientId,
      now,
    );
  }

  /** The `screen:advance` checks, and the pack and clip the gateway reads
   *  with one primary-key lookup of `vj_pack_clips`. */
  prepareScreenAdvance(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
  ): VjAdvanceCheck {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return refuseAdvance('vj_not_attached');
    }
    return checkAdvance(stage, socketId, payload);
  }

  /** Reruns the advance checks (a remote tap since the prepare makes it
   *  stale) and applies it like `stage:goClip` with cause `'shuffle'`. */
  applyScreenAdvance(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
    isClipInPack: boolean,
    now: number,
  ): VjStageOutcome {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { ok: false, failure: vjAckFailure('vj_not_attached') };
    }
    const entry = screenEntryOfSocket(stage, socketId);
    if (entry !== null) {
      entry.lastSeenAt = now;
    }
    const check = checkAdvance(stage, socketId, payload);
    if (check.failure !== null) {
      return { ok: false, failure: check.failure };
    }
    if (!isClipInPack) {
      return { ok: false, failure: vjAckFailure('vj_clip_not_in_pack') };
    }
    return this.applyPatch(
      stage,
      {
        ...stage.state,
        liveClipId: check.clipId,
        clipSequence: stage.state.clipSequence + 1,
      },
      'shuffle',
      null,
      now,
    );
  }

  /** Stores a screen's fullscreen flag and preload report. Answers false for
   *  an unknown socket or a malformed payload, leaving the entry as it was. */
  updateScreenStatus(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
    now: number,
  ): boolean {
    const stage = this.stages.get(adminUserId);
    const entry = stage ? screenEntryOfSocket(stage, socketId) : null;
    if (entry === null) {
      return false;
    }
    const status = parseScreenStatus(payload);
    if (status === null) {
      return false;
    }
    entry.isFullscreen = status.isFullscreen;
    entry.preload = status.preload;
    entry.lastSeenAt = now;
    return true;
  }

  /** Every screen of the stage sorted by `number`, offline ones included
   *  until their retention ends. */
  listScreens(adminUserId: string, now: number): VjScreenStatus[] {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return [];
    }
    pruneOfflineScreens(stage, now);
    const leadSocketId = leadSocketIdOfStage(stage);
    return Array.from(stage.screens.values())
      .map((entry) => ({
        screenId: entry.screenId,
        number: entry.number,
        isConnected: entry.socketId !== null,
        isLead: entry.socketId !== null && entry.socketId === leadSocketId,
        isFullscreen: entry.isFullscreen,
        connectedAt: entry.connectedAt,
        lastSeenAt: entry.lastSeenAt,
        preload: {
          packId: entry.preload.packId,
          clips: entry.preload.clips.map((clip) => ({ ...clip })),
        },
      }))
      .sort((first, second) => first.number - second.number);
  }

  /** The socket of the screen that leads now, or null. */
  leadSocketIdOf(adminUserId: string): string | null {
    const stage = this.stages.get(adminUserId);
    return stage === undefined ? null : leadSocketIdOfStage(stage);
  }

  /** Applies a library change to every stage it touches and answers one
   *  frame per changed stage, cause `'library'`. */
  applyLibraryChange(
    change: VjLibraryChange,
    now: number,
  ): { adminUserId: string; frame: VjStageFrame }[] {
    const frames: { adminUserId: string; frame: VjStageFrame }[] = [];
    for (const stage of this.stages.values()) {
      const proposed = libraryChangeState(stage.state, change);
      if (proposed === null) {
        continue;
      }
      const outcome = this.applyPatch(stage, proposed, 'library', null, now);
      if (outcome.frame !== null) {
        frames.push({ adminUserId: stage.adminUserId, frame: outcome.frame });
      }
    }
    return frames;
  }

  /** Prunes offline screens and drops every stage with no attached socket
   *  for over `VJ_STAGE_IDLE_EVICTION_MS`, its strobe timer with it. */
  sweep(now: number): void {
    for (const [adminUserId, stage] of this.stages) {
      pruneOfflineScreens(stage, now);
      if (
        stage.attachedSocketIds.size === 0 &&
        stage.idleSince !== null &&
        now - stage.idleSince > VJ_STAGE_IDLE_EVICTION_MS
      ) {
        this.clearStrobeTimer(stage);
        this.stages.delete(adminUserId);
      }
    }
  }

  /** Clears every strobe timer. */
  onModuleDestroy(): void {
    for (const stage of this.stages.values()) {
      this.clearStrobeTimer(stage);
    }
  }

  private ensureStage(adminUserId: string, now: number): VjStage {
    const existing = this.stages.get(adminUserId);
    if (existing !== undefined) {
      return existing;
    }
    const stage: VjStage = {
      adminUserId,
      state: createVjStageState(randomUUID(), now),
      screens: new Map(),
      highestScreenNumber: 0,
      connectionCounter: 0,
      clientSequences: new Map(),
      attachedSocketIds: new Set(),
      idleSince: null,
      strobeTimer: null,
    };
    this.stages.set(adminUserId, stage);
    return stage;
  }

  /** Points the screen's entry at the new socket, creating and numbering it on
   *  first attach. Answers the older socket it replaced, if any. */
  private connectScreen(
    stage: VjStage,
    screenId: string,
    socketId: string,
    now: number,
  ): string | null {
    stage.connectionCounter += 1;
    const existing = stage.screens.get(screenId);
    if (existing === undefined) {
      stage.highestScreenNumber += 1;
      stage.screens.set(screenId, {
        screenId,
        number: stage.highestScreenNumber,
        socketId,
        isFullscreen: false,
        connectedAt: now,
        connectionOrder: stage.connectionCounter,
        disconnectedAt: null,
        lastSeenAt: now,
        preload: { packId: null, clips: [] },
      });
      return null;
    }
    const previousSocketId = existing.socketId;
    const replacedSocketId =
      previousSocketId !== null && previousSocketId !== socketId
        ? previousSocketId
        : null;
    if (replacedSocketId !== null) {
      stage.attachedSocketIds.delete(replacedSocketId);
    }
    existing.socketId = socketId;
    existing.connectedAt = now;
    existing.connectionOrder = stage.connectionCounter;
    existing.disconnectedAt = null;
    existing.lastSeenAt = now;
    return replacedSocketId;
  }

  /** Compares, bumps `revision`, stamps `updatedAt`, keeps the strobe timer in
   *  step and builds the frame. A change that alters nothing is a noop. */
  private applyPatch(
    stage: VjStage,
    proposed: VjStageState,
    cause: VjStageCause,
    sourceClientId: string | null,
    now: number,
  ): VjAppliedOutcome {
    const previous = stage.state;
    const nextState = withStrobeStamp(previous, proposed, now);
    if (isSameStageContent(previous, nextState)) {
      return {
        ok: true,
        success: { revision: previous.revision, isNoop: true },
        frame: null,
      };
    }
    const applied: VjStageState = {
      ...nextState,
      revision: previous.revision + 1,
      updatedAt: now,
    };
    stage.state = applied;
    if (applied.effects.isStrobing && !previous.effects.isStrobing) {
      this.armStrobeTimer(stage);
    } else if (!applied.effects.isStrobing) {
      this.clearStrobeTimer(stage);
    }
    return {
      ok: true,
      success: { revision: applied.revision, isNoop: false },
      frame: { state: applied, cause, sourceClientId },
    };
  }

  private armStrobeTimer(stage: VjStage): void {
    this.clearStrobeTimer(stage);
    const timer = setTimeout(() => {
      this.handleStrobeTimeout(stage.adminUserId, timer);
    }, VJ_LIMITS.strobeMaxDurationMs);
    timer.unref();
    stage.strobeTimer = timer;
  }

  private clearStrobeTimer(stage: VjStage): void {
    if (stage.strobeTimer !== null) {
      clearTimeout(stage.strobeTimer);
      stage.strobeTimer = null;
    }
  }

  /** Turns the strobe off 10 s after it went on and broadcasts with cause
   *  `'strobe_timeout'`. A timer the stage no longer holds does nothing. */
  private handleStrobeTimeout(
    adminUserId: string,
    timer: NodeJS.Timeout,
  ): void {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined || stage.strobeTimer !== timer) {
      return;
    }
    stage.strobeTimer = null;
    if (!stage.state.effects.isStrobing) {
      return;
    }
    const outcome = this.applyPatch(
      stage,
      {
        ...stage.state,
        effects: {
          ...stage.state.effects,
          isStrobing: false,
          strobeStartedAt: null,
        },
      },
      'strobe_timeout',
      null,
      Date.now(),
    );
    if (outcome.frame !== null) {
      this.broadcaster?.broadcastState(adminUserId, outcome.frame);
    }
  }
}
