import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { vjAckFailure } from './vj.constants';
import {
  canonicalVjStageState,
  createVjStageState,
  isSameVjStageContent,
  type VjAckFailure,
  type VjCommandSuccess,
  type VjLibraryChange,
  type VjRemoteCommandName,
  type VjScreenStatus,
  type VjSocketErrorCode,
  type VjStageCause,
  type VjStageFrame,
  type VjStageState,
} from './vj.contract';
import { resolveVjLookups } from './vj-lookup-resolver';
import { VjStageReadsService } from './vj-stage-reads.service';
import {
  isSameVjLookupList,
  ruleForVjCommand,
  VJ_SELF_STALE_CHECKED_COMMANDS,
} from './stage/vj-command-rules';
import { vjLibraryChangeState } from './stage/vj-library-effects';
import {
  stampVjChangeTimes,
  vjApplyAtFor,
  vjAttachApplyAt,
} from './stage/vj-quantize';
import { restoredVjStageState, vjRestoreLookups } from './stage/vj-restore';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  isRecord,
  isUuidString,
  vjPackClipKey,
  type VjAcceptedChange,
  type VjCommandLookup,
  type VjLookupResults,
  type VjRuleContext,
} from './stage/vj-rule-kit';
import {
  parseVjScreenStatus,
  toVjScreenStatusList,
  type VjScreenEntry,
} from './stage/vj-screen-status';
import { applyVjAdvance, checkVjAdvance } from './stage/vj-shuffle-rules';
import {
  VJ_TIMER_CAUSES,
  VjStageTimers,
  vjTimerFireState,
  type VjTimerKind,
} from './stage/vj-stage-timers';
import { adoptVjMicTempo } from './stage/vj-tempo-rules';

export type { VjRemoteCommandName } from './vj.contract';
export type { VjCommandLookup } from './stage/vj-rule-kit';

/** How long a disconnected screen stays in the list as offline (contract 6.7). */
export const VJ_SCREEN_OFFLINE_RETENTION_MS = 600_000;

/** How long a stage with no attached socket lives before the sweep drops it
 *  (contract 6.13). */
export const VJ_STAGE_IDLE_EVICTION_MS = 21_600_000;

/** Most client ids whose last command sequence one stage remembers; the least
 *  recently used one is forgotten first (contract 6.5). */
export const VJ_CLIENT_SEQUENCE_MEMORY = 32;

/** How many times one command's lookups are read: once, and once more when a
 *  change between the prepare and apply steps made its rule list other reads. */
const VJ_LOOKUP_READ_ATTEMPTS = 2;

/** Where the gateway hands a frame the service produced on its own clock
 *  (a strobe, overlay or countdown timer) to the stage room. */
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
 *  from `isLead`). `applyAt` is what the attach frame carries: null after a
 *  restore, else the pending applyAt while it is in the future. */
export type VjScreenAttachOutcome =
  | {
      ok: true;
      state: VjStageState;
      isRestored: boolean;
      isLead: boolean;
      screenNumber: number;
      applyAt: number | null;
      replacedSocketId: string | null;
      leadChange: VjLeadChange | null;
    }
  | { ok: false; failure: VjAckFailure };

/** Why a lookup read ended without an apply: a read rejected, or the
 *  lookups the rule lists moved on both reads. */
type VjLookupReadRefusal = 'read_failed' | 'lookups_moved';

/** What a prepare step answers: a refusal, or the reads the apply step needs. */
export type VjPreparedLookups =
  | { failure: VjAckFailure; lookups: [] }
  | { failure: null; lookups: VjCommandLookup[] };

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
  /** The last stamped applyAt (contract 7.4, memory only). */
  pendingApplyAt: number | null;
  timers: VjStageTimers;
  lastMicAdoptedAt: number | null;
}

/** What the client id and stale checks answer. */
type VjClientCheck =
  | { failure: VjAckFailure; clientId: null; commandSequence: null }
  | { failure: null; clientId: string; commandSequence: number };

type VjAppliedOutcome = Extract<VjStageOutcome, { ok: true }>;

/** A refused outcome. */
function refuseOutcome(code: VjSocketErrorCode): VjStageOutcome {
  return { ok: false, failure: vjAckFailure(code) };
}

/** A change the server makes on its own (timers, mic adoption, library):
 *  `isImmediate` and `isLookSwitch` false, an empty lookup list, `hideAt` kept. */
function serverVjChange(nextState: VjStageState): VjAcceptedChange {
  return {
    nextState,
    lookups: [],
    isImmediate: false,
    isLookSwitch: false,
    overlayHideAfterMs: undefined,
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

/** The screen ids of the stage with a socket attached now. */
function connectedScreenIdsOf(stage: VjStage): Set<string> {
  const screenIds = new Set<string>();
  for (const entry of stage.screens.values()) {
    if (entry.socketId !== null) {
      screenIds.add(entry.screenId);
    }
  }
  return screenIds;
}

/** What every rule reads besides the state and the payload. */
function ruleContextOf(
  stage: VjStage,
  now: number,
  lookups: VjLookupResults | null,
): VjRuleContext {
  const lead = leadEntryOf(stage);
  return {
    now,
    lookups,
    connectedScreenIds: connectedScreenIdsOf(stage),
    isLeadMicOn: lead !== null && lead.mic !== null,
  };
}

/** Drops screens offline for over `VJ_SCREEN_OFFLINE_RETENTION_MS` (v1 note 12). */
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

/** The state without override entries of screens the stage no longer lists
 *  (plan note 22, contract 7.10 last bullet). */
function withoutDepartedScreenOverrides(
  state: VjStageState,
  screens: ReadonlyMap<string, VjScreenEntry>,
): VjStageState {
  const overrideScreenIds = Object.keys(state.screenOverrides);
  if (overrideScreenIds.every((screenId) => screens.has(screenId))) {
    return state;
  }
  return {
    ...state,
    screenOverrides: Object.fromEntries(
      Object.entries(state.screenOverrides).filter(([screenId]) =>
        screens.has(screenId),
      ),
    ),
  };
}

/**
 * Contract 7.4 for one accepted change, in order: screens offline past their
 * retention pruned first (plan note 22, so a screen that left the list since
 * the last `listScreens` or sweep loses its override here), the canonical
 * next state, its applyAt, then the overrides of departed screens dropped
 * (after the grid check, so that drop never puts an unrelated change on the
 * beat; the demo keeps the same order), the time stamps, the noop compare,
 * then the pending
 * applyAt, the revision, the timers and the frame. A noop answers applyAt
 * null and leaves the pending applyAt alone.
 */
function landVjChange(
  stage: VjStage,
  accepted: VjAcceptedChange,
  cause: VjStageCause,
  sourceClientId: string | null,
  now: number,
): VjAppliedOutcome {
  pruneOfflineScreens(stage, now);
  const previous = stage.state;
  const proposed = canonicalVjStageState(accepted.nextState);
  const applyAt = vjApplyAtFor({
    previous,
    next: proposed,
    isLookSwitch: accepted.isLookSwitch,
    isImmediate: accepted.isImmediate,
    cause,
    pendingApplyAt: stage.pendingApplyAt,
    now,
  });
  const stamped = stampVjChangeTimes(
    previous,
    withoutDepartedScreenOverrides(proposed, stage.screens),
    applyAt ?? now,
    accepted.overlayHideAfterMs,
  );
  if (isSameVjStageContent(previous, stamped)) {
    return {
      ok: true,
      success: { revision: previous.revision, isNoop: true, applyAt: null },
      frame: null,
    };
  }
  const applied = canonicalVjStageState({
    ...stamped,
    revision: previous.revision + 1,
    updatedAt: now,
  });
  stage.pendingApplyAt = applyAt;
  stage.state = applied;
  stage.timers.sync(applied);
  return {
    ok: true,
    success: { revision: applied.revision, isNoop: false, applyAt },
    frame: { state: applied, cause, sourceClientId, applyAt },
  };
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

/** A fresh screen entry for a first attach. */
function newScreenEntry(
  screenId: string,
  number: number,
  socketId: string,
  connectionOrder: number,
  now: number,
): VjScreenEntry {
  return {
    screenId,
    number,
    socketId,
    isFullscreen: false,
    connectedAt: now,
    connectionOrder,
    disconnectedAt: null,
    lastSeenAt: now,
    preload: { packId: null, clips: [] },
    health: null,
    nextClipId: null,
    mic: null,
  };
}

/**
 * The live VJ stages. One stage per admin user id, held in process memory
 * only: `chat/chat-single-instance.guard.ts` keeps the backend on one
 * replica, so every screen and remote of an admin reaches this map. Nothing
 * is written to the database and nothing is logged. The rules live in the
 * pure modules under `stage/`; this service keeps the stage map, screens,
 * sequences, timers and the one change landing of contract 7.4. It touches
 * no socket: the gateway fans out the frames it returns (contract 7).
 */
@Injectable()
export class VjStageService implements OnModuleDestroy {
  private readonly stages = new Map<string, VjStage>();
  private broadcaster: VjStageBroadcaster | null = null;

  constructor(private readonly stageReads: VjStageReadsService) {}

  /** Where timer frames broadcast; the gateway binds itself on init. */
  bindBroadcaster(broadcaster: VjStageBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  /** The admin's stage state, or null when no stage is in memory. */
  getState(adminUserId: string): VjStageState | null {
    return this.stages.get(adminUserId)?.state ?? null;
  }

  /** The admin's last stamped applyAt (contract 7.4), or null with no stage
   *  in memory. An attach frame built later reads it with its state. */
  getPendingApplyAt(adminUserId: string): number | null {
    return this.stages.get(adminUserId)?.pendingApplyAt ?? null;
  }

  /** Whether a screen's restore would be adopted now: no stage yet, or one at
   *  revision 0. The gateway reads the restore lookups only then. */
  shouldAdoptRestore(adminUserId: string): boolean {
    const stage = this.stages.get(adminUserId);
    return stage === undefined || stage.state.revision === 0;
  }

  /** The reads a restore needs (contract 7.13), for the gateway's resolver. */
  restoreLookupsOf(restoreState: unknown, now: number): VjCommandLookup[] {
    return vjRestoreLookups(restoreState, now);
  }

  /** Attaches a screen: creates the stage when there is none, adopts a
   *  restore at revision 0 (with its reads), reuses or numbers the screen
   *  entry, replaces an older socket of the same screen, and settles the lead. */
  attachScreen(
    input: {
      adminUserId: string;
      socketId: string;
      screenId: unknown;
      restoreState: unknown;
      restoreReads: VjLookupResults | null;
    },
    now: number,
  ): VjScreenAttachOutcome {
    if (!isUuidString(input.screenId)) {
      return { ok: false, failure: vjAckFailure('vj_screen_id_invalid') };
    }
    const screenId = input.screenId.toLowerCase();
    const stage = this.ensureStage(input.adminUserId, now);
    const isRestored = this.adoptRestore(stage, input, now);
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
    return {
      ok: true,
      state: stage.state,
      isRestored,
      isLead: leadAfter === input.socketId,
      screenNumber: stage.screens.get(screenId)?.number ?? 0,
      applyAt: isRestored ? null : vjAttachApplyAt(stage.pendingApplyAt, now),
      replacedSocketId,
      leadChange:
        leadAfter !== leadBefore && leadAfter !== input.socketId
          ? { promotedSocketId: leadAfter }
          : null,
    };
  }

  /** Attaches a remote, creating the stage when there is none. */
  attachRemote(
    adminUserId: string,
    socketId: string,
    now: number,
  ): { state: VjStageState; applyAt: number | null } {
    const stage = this.ensureStage(adminUserId, now);
    stage.attachedSocketIds.add(socketId);
    stage.idleSince = null;
    return {
      state: stage.state,
      applyAt: vjAttachApplyAt(stage.pendingApplyAt, now),
    };
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

  /** The client id, stale and field checks of a remote command with no
   *  lookups read, recording nothing, and the reads it needs. A refusal here
   *  is answered through `applyRemoteCommand`, which reruns the checks,
   *  records the sequence (note 20) and answers the same code. */
  prepareRemoteCommand(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
    now: number,
  ): VjPreparedLookups {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { failure: vjAckFailure('vj_not_attached'), lookups: [] };
    }
    const clientCheck = checkClientCommand(stage, payload);
    if (clientCheck.failure !== null) {
      return { failure: clientCheck.failure, lookups: [] };
    }
    const rule = ruleForVjCommand(
      name,
      stage.state,
      payload,
      ruleContextOf(stage, now, null),
    );
    if (rule.failure !== null) {
      return { failure: rule.failure, lookups: [] };
    }
    return { failure: null, lookups: rule.accepted.lookups };
  }

  /** Reruns every check of a remote command with the lookup answers, records
   *  its sequence on every outcome past the stale check, and lands it. */
  applyRemoteCommand(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
    lookups: VjLookupResults,
    now: number,
  ): VjStageOutcome {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return refuseOutcome('vj_not_attached');
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
    const rule = ruleForVjCommand(
      name,
      stage.state,
      payload,
      ruleContextOf(stage, now, lookups),
    );
    if (rule.failure !== null) {
      return { ok: false, failure: rule.failure };
    }
    return landVjChange(
      stage,
      rule.accepted,
      'command',
      clientCheck.clientId,
      now,
    );
  }

  /** One remote command end to end: prepare, read its lookups, apply. When a
   *  change landed between the reads and the apply (a `setPack` before a
   *  `setShuffle`), the rule lists other reads; they are read once more. A
   *  rejected read answers vj_server_error and lookups that move on both
   *  reads answer vj_stale_command with the state; both record the sequence
   *  (plan note 20). `clock` is read at each step. */
  async runRemoteCommand(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
    clock: () => number = () => Date.now(),
  ): Promise<VjStageOutcome> {
    const prepared = this.prepareRemoteCommand(
      adminUserId,
      name,
      payload,
      clock(),
    );
    if (prepared.failure !== null) {
      return this.applyRemoteCommand(
        adminUserId,
        name,
        payload,
        EMPTY_VJ_LOOKUP_RESULTS,
        clock(),
      );
    }
    return this.readAndApply(
      prepared.lookups,
      (now) => this.relistRemoteLookups(adminUserId, name, payload, now),
      (results, now) =>
        this.applyRemoteCommand(adminUserId, name, payload, results, now),
      (reason) => this.refuseRemoteRead(adminUserId, payload, reason),
      clock,
    );
  }

  /** The answer of a remote command whose lookup read ended without an
   *  apply. It reruns the client checks (a newer command of the same client
   *  makes it stale), records the sequence (plan note 20), then answers
   *  vj_server_error for a rejected read and vj_stale_command with the state
   *  for lookups that moved on both reads. */
  private refuseRemoteRead(
    adminUserId: string,
    payload: Record<string, unknown>,
    reason: VjLookupReadRefusal,
  ): VjStageOutcome {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return refuseOutcome('vj_not_attached');
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
    return reason === 'read_failed'
      ? refuseOutcome('vj_server_error')
      : { ok: false, failure: vjAckFailure('vj_stale_command', stage.state) };
  }

  /** The `screen:advance` checks with no read, and the `packClip` lookup. */
  prepareScreenAdvance(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
  ): VjPreparedLookups {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { failure: vjAckFailure('vj_not_attached'), lookups: [] };
    }
    const isLead = leadSocketIdOfStage(stage) === socketId;
    const check = checkVjAdvance(stage.state, isLead, payload);
    if (check.failure !== null) {
      return { failure: check.failure, lookups: [] };
    }
    return { failure: null, lookups: check.lookups };
  }

  /** Reruns the advance checks (a remote tap since the prepare makes it
   *  stale), then the `packClip` answer, and lands it like `stage:goClip`
   *  with cause `'shuffle'`. */
  applyScreenAdvance(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
    lookups: VjLookupResults,
    now: number,
  ): VjStageOutcome {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return refuseOutcome('vj_not_attached');
    }
    const entry = screenEntryOfSocket(stage, socketId);
    if (entry !== null) {
      entry.lastSeenAt = now;
    }
    const isLead = leadSocketIdOfStage(stage) === socketId;
    const check = checkVjAdvance(stage.state, isLead, payload);
    if (check.failure !== null) {
      return { ok: false, failure: check.failure };
    }
    const packClip =
      lookups.packClips.get(vjPackClipKey(check.packId, check.clipId)) ?? null;
    const advance = applyVjAdvance(stage.state, check, packClip);
    if (advance.failure !== null) {
      return { ok: false, failure: advance.failure };
    }
    return landVjChange(
      stage,
      serverVjChange(advance.nextState),
      'shuffle',
      null,
      now,
    );
  }

  /** One `screen:advance` end to end, with the same second read as
   *  `runRemoteCommand`. */
  async runScreenAdvance(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
    clock: () => number = () => Date.now(),
  ): Promise<VjStageOutcome> {
    const prepared = this.prepareScreenAdvance(adminUserId, socketId, payload);
    if (prepared.failure !== null) {
      return this.applyScreenAdvance(
        adminUserId,
        socketId,
        payload,
        EMPTY_VJ_LOOKUP_RESULTS,
        clock(),
      );
    }
    return this.readAndApply(
      prepared.lookups,
      () => {
        const relisted = this.prepareScreenAdvance(
          adminUserId,
          socketId,
          payload,
        );
        return relisted.failure === null ? relisted.lookups : null;
      },
      (results, now) =>
        this.applyScreenAdvance(adminUserId, socketId, payload, results, now),
      () => refuseOutcome('vj_server_error'),
      clock,
    );
  }

  /** Stores a screen's status (contract 7.9). Answers `isStored` false for an
   *  unknown socket or a malformed fullscreen or preload pair. A lead's mic
   *  report may adopt the tempo, answered as a `mic_tempo` frame. */
  updateScreenStatus(
    adminUserId: string,
    socketId: string,
    payload: Record<string, unknown>,
    now: number,
  ): { isStored: boolean; frame: VjStageFrame | null } {
    const stage = this.stages.get(adminUserId);
    const entry = stage ? screenEntryOfSocket(stage, socketId) : null;
    if (stage === undefined || entry === null) {
      return { isStored: false, frame: null };
    }
    const isLead = leadSocketIdOfStage(stage) === socketId;
    const status = parseVjScreenStatus(payload, isLead, now);
    if (status === null) {
      return { isStored: false, frame: null };
    }
    entry.isFullscreen = status.isFullscreen;
    entry.preload = status.preload;
    entry.health = status.health;
    entry.nextClipId = status.nextClipId;
    entry.mic = status.mic;
    entry.lastSeenAt = now;
    return { isStored: true, frame: this.adoptMicTempo(stage, entry, now) };
  }

  /** Every screen of the stage sorted by `number`, offline ones included
   *  until their retention ends. The lead's next clip is relayed only while
   *  shuffle is on. */
  listScreens(adminUserId: string, now: number): VjScreenStatus[] {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return [];
    }
    pruneOfflineScreens(stage, now);
    const screens = toVjScreenStatusList(
      stage.screens.values(),
      leadSocketIdOfStage(stage),
    );
    if (stage.state.shuffle.isOn) {
      return screens;
    }
    return screens.map((screen) => ({ ...screen, nextClipId: null }));
  }

  /** The socket of the screen that leads now, or null. */
  leadSocketIdOf(adminUserId: string): string | null {
    const stage = this.stages.get(adminUserId);
    return stage === undefined ? null : leadSocketIdOfStage(stage);
  }

  /** The screen sockets `screen:identify` reaches: the named connected
   *  screen, or every connected screen for a null id. */
  identifyTargets(
    adminUserId: string,
    screenId: unknown,
  ):
    | { failure: VjAckFailure; targets: [] }
    | { failure: null; targets: { socketId: string; number: number }[] } {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { failure: vjAckFailure('vj_not_attached'), targets: [] };
    }
    const targets: { socketId: string; number: number }[] = [];
    for (const entry of stage.screens.values()) {
      const isNamed =
        screenId === null ||
        (isUuidString(screenId) && entry.screenId === screenId.toLowerCase());
      if (isNamed && entry.socketId !== null) {
        targets.push({ socketId: entry.socketId, number: entry.number });
      }
    }
    targets.sort((first, second) => first.number - second.number);
    if (screenId !== null && targets.length === 0) {
      return { failure: vjAckFailure('vj_screen_not_attached'), targets: [] };
    }
    return { failure: null, targets };
  }

  /** The listed set list ids (lowercased) that some stage has active. */
  activeSetlistIdsAmong(setlistIds: readonly string[]): string[] {
    const activeIds = new Set<string>();
    for (const stage of this.stages.values()) {
      if (stage.state.activeSetlistId !== null) {
        activeIds.add(stage.state.activeSetlistId);
      }
    }
    const listed = new Set(
      setlistIds.map((setlistId) => setlistId.toLowerCase()),
    );
    return Array.from(listed).filter((setlistId) => activeIds.has(setlistId));
  }

  /** Applies a library change to every stage it touches (contract 7.10) and
   *  answers one frame per changed stage, cause `'library'`. */
  applyLibraryChange(
    change: VjLibraryChange,
    now: number,
    setlistItemCounts: ReadonlyMap<string, number | null>,
  ): { adminUserId: string; frame: VjStageFrame }[] {
    const frames: { adminUserId: string; frame: VjStageFrame }[] = [];
    for (const stage of this.stages.values()) {
      const proposed = vjLibraryChangeState(
        stage.state,
        change,
        setlistItemCounts,
      );
      if (proposed === null) {
        continue;
      }
      const outcome = landVjChange(
        stage,
        serverVjChange(proposed),
        'library',
        null,
        now,
      );
      if (outcome.frame !== null) {
        frames.push({ adminUserId: stage.adminUserId, frame: outcome.frame });
      }
    }
    return frames;
  }

  /** Prunes offline screens and drops every stage with no attached socket
   *  for over `VJ_STAGE_IDLE_EVICTION_MS`, its timers with it. */
  sweep(now: number): void {
    for (const [adminUserId, stage] of this.stages) {
      pruneOfflineScreens(stage, now);
      if (
        stage.attachedSocketIds.size === 0 &&
        stage.idleSince !== null &&
        now - stage.idleSince > VJ_STAGE_IDLE_EVICTION_MS
      ) {
        stage.timers.clear();
        this.stages.delete(adminUserId);
      }
    }
  }

  /** Clears every stage's timers. */
  onModuleDestroy(): void {
    for (const stage of this.stages.values()) {
      stage.timers.clear();
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
      pendingApplyAt: null,
      timers: new VjStageTimers((kind) => {
        this.handleTimerFire(stage, kind);
      }),
      lastMicAdoptedAt: null,
    };
    this.stages.set(adminUserId, stage);
    return stage;
  }

  /** Contract 7.13 adoption at revision 0, when the gateway read the restore's
   *  lookups: the restored state, the pending applyAt cleared, timers armed. */
  private adoptRestore(
    stage: VjStage,
    input: { restoreState: unknown; restoreReads: VjLookupResults | null },
    now: number,
  ): boolean {
    if (
      stage.state.revision !== 0 ||
      input.restoreReads === null ||
      !isRecord(input.restoreState)
    ) {
      return false;
    }
    stage.state = canonicalVjStageState(
      restoredVjStageState(
        stage.state,
        input.restoreState,
        input.restoreReads,
        now,
      ),
    );
    stage.pendingApplyAt = null;
    stage.timers.sync(stage.state);
    return true;
  }

  /** Points the screen's entry at the new socket, creating and numbering it on
   *  first attach. A returning screen's health, next clip and mic wait for
   *  its next status. Answers the older socket it replaced, if any. */
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
      stage.screens.set(
        screenId,
        newScreenEntry(
          screenId,
          stage.highestScreenNumber,
          socketId,
          stage.connectionCounter,
          now,
        ),
      );
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
    Object.assign(existing, {
      socketId,
      connectedAt: now,
      connectionOrder: stage.connectionCounter,
      disconnectedAt: null,
      lastSeenAt: now,
      health: null,
      nextClipId: null,
      mic: null,
    });
    return replacedSocketId;
  }

  /** The lookups a remote command lists against the state it would apply to
   *  now; null when it no longer lists any to compare (it refuses, or it is
   *  a set list step that answers vj_stale_setlist itself). */
  private relistRemoteLookups(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
    now: number,
  ): VjCommandLookup[] | null {
    if (VJ_SELF_STALE_CHECKED_COMMANDS.includes(name)) {
      return null;
    }
    const prepared = this.prepareRemoteCommand(adminUserId, name, payload, now);
    return prepared.failure === null ? prepared.lookups : null;
  }

  /** Reads the lookups (none: no await, so the apply runs in the same tick),
   *  re-lists them against the current state, reads once more when they
   *  differ, then applies. A rejected read, or lookups that move on both
   *  reads, answer through `refuse`. */
  private async readAndApply(
    firstLookups: VjCommandLookup[],
    relist: (now: number) => VjCommandLookup[] | null,
    apply: (results: VjLookupResults, now: number) => VjStageOutcome,
    refuse: (reason: VjLookupReadRefusal) => VjStageOutcome,
    clock: () => number,
  ): Promise<VjStageOutcome> {
    let lookups = firstLookups;
    for (let attempt = 1; attempt <= VJ_LOOKUP_READ_ATTEMPTS; attempt += 1) {
      let results: VjLookupResults = EMPTY_VJ_LOOKUP_RESULTS;
      if (lookups.length > 0) {
        try {
          results = await resolveVjLookups(this.stageReads, lookups);
        } catch {
          return refuse('read_failed');
        }
      }
      const now = clock();
      const relisted = relist(now);
      if (relisted === null || isSameVjLookupList(relisted, lookups)) {
        return apply(results, now);
      }
      lookups = relisted;
    }
    return refuse('lookups_moved');
  }

  /** Contract 7.9 mic adoption on the lead's status: a `mic_tempo` change
   *  when the tempo follows the mic and the report moved it. */
  private adoptMicTempo(
    stage: VjStage,
    entry: VjScreenEntry,
    now: number,
  ): VjStageFrame | null {
    if (entry.mic === null || leadEntryOf(stage) !== entry) {
      return null;
    }
    const tempo = adoptVjMicTempo(
      stage.state.tempo,
      entry.mic,
      stage.lastMicAdoptedAt,
      now,
    );
    if (tempo === null) {
      return null;
    }
    stage.lastMicAdoptedAt = now;
    return landVjChange(
      stage,
      serverVjChange({ ...stage.state, tempo }),
      'mic_tempo',
      null,
      now,
    ).frame;
  }

  /** Lands a fired timer's state (contract 7.14) with its cause, broadcasts
   *  it, then syncs the timers again. A stage evicted since does nothing. */
  private handleTimerFire(stage: VjStage, kind: VjTimerKind): void {
    if (this.stages.get(stage.adminUserId) !== stage) {
      return;
    }
    const fired = vjTimerFireState(kind, stage.state);
    if (fired !== null) {
      const outcome = landVjChange(
        stage,
        serverVjChange(fired),
        VJ_TIMER_CAUSES[kind],
        null,
        Date.now(),
      );
      if (outcome.frame !== null) {
        this.broadcaster?.broadcastState(stage.adminUserId, outcome.frame);
      }
    }
    stage.timers.sync(stage.state);
  }
}
