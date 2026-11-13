import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { vjAckFailure } from './vj.constants';
import {
  canonicalVjStageState,
  createVjStageState,
  isSameVjStageContent,
  VJ_LIMITS,
  vjSetlistFollowState,
  vjSetlistTimerReadPosition,
  vjSetlistTimerTargetAt,
  vjSetlistTimerTransition,
  type VjAckFailure,
  type VjCommandSuccess,
  type VjLibraryChange,
  type VjRemoteCommandName,
  type VjRenderer,
  type VjScreenStatus,
  type VjSetlistFollowRead,
  type VjSetlistRead,
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
import {
  restoredVjStageState,
  vjRestoreLookups,
  vjRestoreSetlistRead,
} from './stage/vj-restore';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  isRecord,
  isUuidString,
  VJ_SETLIST_CLOCK_KEEP,
  vjPackClipKey,
  vjSetlistItemKey,
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
import { vjSetlistTransitionChange } from './stage/vj-scene-recall';
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

/** What a remote write before a landing (the Loop save of
 *  `stage:setlistSetLooping`, sequences 5.6) answers when it fails, or when
 *  another remote moved the active set list while it ran
 *  (`vj_stale_setlist`, sent with the state). */
export type VjRemoteWriteRefusal =
  'vj_setlist_not_found' | 'vj_server_error' | 'vj_stale_setlist';

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
  /** Screen sockets that sent a stored `screen:status` since they attached,
   *  so the live list can tell a reported fullscreen flag from the default. */
  statusReportedSocketIds: Set<string>;
  /** The active set list's item ids in play order, from the last read that
   *  answered them (sequences 5.4, memory only, never sent); null with no
   *  active set list or before any read. Index follow reads it. */
  setlistItemIds: string[] | null;
  /** The lowercased set list id `setlistItemIds` belongs to; null with none. */
  setlistItemIdsSetlistId: string | null;
  /** How many library follows stored item ids so far. A command read that
   *  started before the latest one never overwrites them: its ids are older. */
  setlistFollowCount: number;
}

/** The set list reads a landing refreshes `setlistItemIds` from, and the
 *  stage's follow count when they were started (null: no follow can have
 *  landed meanwhile, as for the step timer, whose stale check rereads). */
interface VjLandingSetlistReads {
  reads: Iterable<VjSetlistRead | null>;
  followCountAtRead: number | null;
}

const NO_LANDING_SETLIST_READS: VjLandingSetlistReads = Object.freeze({
  reads: [],
  followCountAtRead: null,
});

/** One connected screen as the live connections list reads it. */
export interface VjLiveScreenRead {
  socketId: string;
  number: number;
  isLead: boolean;
  /** Epoch ms of the attach. */
  connectedAt: number;
  /** Null until the screen sends a stored status report. */
  isFullscreen: boolean | null;
  /** Null until the screen reports valid health. */
  renderer: VjRenderer | null;
}

/** One stage in memory as the live connections list reads it: its connected
 *  screens by number, and every socket the stage holds (screens and remotes). */
export interface VjLiveStageRead {
  adminUserId: string;
  screens: VjLiveScreenRead[];
  attachedSocketIds: string[];
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
 *  `isImmediate` and `isLookSwitch` false, an empty lookup list, `hideAt`
 *  and the set list clock kept, no scheduled step end. */
function serverVjChange(nextState: VjStageState): VjAcceptedChange {
  return {
    nextState,
    lookups: [],
    isImmediate: false,
    isLookSwitch: false,
    overlayHideAfterMs: undefined,
    setlistClock: VJ_SETLIST_CLOCK_KEEP,
    scheduledAt: null,
  };
}

/** Whether two set list ids name the same set list, case ignored. */
function isSameSetlistId(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

/** Keeps `itemIds` (copied, a new array) as the item ids of `setlistId`. */
function storeSetlistItemIds(
  stage: VjStage,
  setlistId: string,
  itemIds: readonly string[],
): void {
  stage.setlistItemIds = [...itemIds];
  stage.setlistItemIdsSetlistId = setlistId.toLowerCase();
}

/** Forgets the item ids: no set list is active. */
function forgetSetlistItemIds(stage: VjStage): void {
  stage.setlistItemIds = null;
  stage.setlistItemIdsSetlistId = null;
}

/** Sequences 5.4: the stage's `setlistItemIds` after a landing. With no
 *  active set list it is null; a read of the active set list among the
 *  reads gives its item ids, unless a library follow stored ids of that same
 *  set list after the read started (the follow's ids are newer); with no
 *  read the memory stays as it was. */
function rememberSetlistItemIds(
  stage: VjStage,
  setlistReads: VjLandingSetlistReads,
): void {
  const activeSetlistId = stage.state.activeSetlistId;
  if (activeSetlistId === null) {
    forgetSetlistItemIds(stage);
    return;
  }
  for (const read of setlistReads.reads) {
    if (read === null || !isSameSetlistId(read.setlistId, activeSetlistId)) {
      continue;
    }
    const isOlderThanFollow =
      setlistReads.followCountAtRead !== null &&
      setlistReads.followCountAtRead !== stage.setlistFollowCount &&
      stage.setlistItemIdsSetlistId === activeSetlistId.toLowerCase();
    if (!isOlderThanFollow) {
      storeSetlistItemIds(stage, activeSetlistId, read.itemIds);
    }
    return;
  }
}

/** Sequences 5.4 after a library follow: the follow read of the active set
 *  list gives its item ids; a set list the change left inactive gives null;
 *  no read for it keeps the memory. */
function rememberFollowedSetlistItemIds(
  stage: VjStage,
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
): void {
  const activeSetlistId = stage.state.activeSetlistId;
  if (activeSetlistId === null) {
    forgetSetlistItemIds(stage);
    return;
  }
  const read = setlistReads.get(activeSetlistId.toLowerCase());
  if (read !== undefined && read !== null) {
    storeSetlistItemIds(stage, activeSetlistId, read.itemIds);
    stage.setlistFollowCount += 1;
  }
}

/** Whether two item id lists hold the same ids in the same order. */
function isSameItemIdList(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return (
    first.length === second.length &&
    first.every((itemId, position) => itemId === second[position])
  );
}

/** Whether the stage holds item ids of `setlistId` that differ from the
 *  ones a newer read answered: a library write committed and its follow has
 *  not landed yet. */
function hasUnfollowedItemEdit(
  stage: VjStage,
  setlistId: string,
  readItemIds: readonly string[],
): boolean {
  return (
    stage.setlistItemIds !== null &&
    stage.setlistItemIdsSetlistId === setlistId.toLowerCase() &&
    !isSameItemIdList(stage.setlistItemIds, readItemIds)
  );
}

/** Whether a command's lookup answers hold a read of the active set list
 *  while a library follow stored newer item ids after the read started: the
 *  rule would place the step on positions the follow has moved. */
function isSetlistReadOlderThanFollow(
  stage: VjStage,
  lookups: VjLookupResults,
  followCountAtRead: number | null,
): boolean {
  const activeSetlistId = stage.state.activeSetlistId;
  if (
    followCountAtRead === null ||
    followCountAtRead === stage.setlistFollowCount ||
    activeSetlistId === null
  ) {
    return false;
  }
  const keyPrefix = `${activeSetlistId.toLowerCase()}:`;
  for (const key of lookups.setlistItems.keys()) {
    if (key.startsWith(keyPrefix)) {
      return true;
    }
  }
  return false;
}

/** What the step timer's fire read from: the state and the item ids array
 *  the stage held (its identity changes on every store). */
interface VjSetlistTimerFire {
  state: VjStageState;
  setlistItemIds: string[] | null;
}

/** Whether something the step timer's fire read from changed while its read
 *  was out (sequences 5.7): the stage epoch, the set list, the index, the
 *  status, the step end, Loop, or the item ids (a step edit). */
function hasSetlistTimerStateMoved(
  fired: VjSetlistTimerFire,
  stage: VjStage,
): boolean {
  const current = stage.state;
  return (
    fired.state.stageEpoch !== current.stageEpoch ||
    fired.state.activeSetlistId !== current.activeSetlistId ||
    fired.state.setlistIndex !== current.setlistIndex ||
    fired.state.setlistPlayback.status !== current.setlistPlayback.status ||
    fired.state.setlistPlayback.stepEndsAt !==
      current.setlistPlayback.stepEndsAt ||
    fired.state.setlistPlayback.isLooping !==
      current.setlistPlayback.isLooping ||
    fired.setlistItemIds !== stage.setlistItemIds
  );
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
 * beat; the demo keeps the same order), the time stamps (the set list clock
 * included, sequences 3.5), the noop compare, then the pending
 * applyAt, the revision, the timers and the frame. A noop answers applyAt
 * null and leaves the pending applyAt alone. Only the step timer's landing
 * (cause `setlist`) places itself by its scheduled step end. Every landing,
 * a noop included, refreshes `setlistItemIds` from `setlistReads`.
 */
function landVjChange(
  stage: VjStage,
  accepted: VjAcceptedChange,
  cause: VjStageCause,
  sourceClientId: string | null,
  now: number,
  setlistReads: VjLandingSetlistReads = NO_LANDING_SETLIST_READS,
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
    scheduledAt: cause === 'setlist' ? accepted.scheduledAt : null,
    pendingApplyAt: stage.pendingApplyAt,
    now,
  });
  const stamped = stampVjChangeTimes(
    previous,
    withoutDepartedScreenOverrides(proposed, stage.screens),
    applyAt ?? now,
    accepted.overlayHideAfterMs,
    accepted.setlistClock,
  );
  if (isSameVjStageContent(previous, stamped)) {
    rememberSetlistItemIds(stage, setlistReads);
    stage.timers.sync(previous);
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
  rememberSetlistItemIds(stage, setlistReads);
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
 * is written to the database; the only log line is a failed step timer
 * landing, naming the stage owner's id. The rules live in the
 * pure modules under `stage/`; this service keeps the stage map, screens,
 * sequences, timers and the one change landing of contract 7.4. It touches
 * no socket: the gateway fans out the frames it returns (contract 7).
 */
@Injectable()
export class VjStageService implements OnModuleDestroy {
  private readonly stages = new Map<string, VjStage>();
  private broadcaster: VjStageBroadcaster | null = null;
  private readonly logger = new Logger(VjStageService.name);

  constructor(private readonly stageReads: VjStageReadsService) {}

  /** Where timer frames broadcast; the gateway binds itself on init. */
  bindBroadcaster(broadcaster: VjStageBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  /** The admin's stage state, or null when no stage is in memory. */
  getState(adminUserId: string): VjStageState | null {
    return this.stages.get(adminUserId)?.state ?? null;
  }

  /** The active set list's item ids the admin's stage holds (sequences 5.4,
   *  memory only), or null with none or no stage in memory. */
  getSetlistItemIds(adminUserId: string): readonly string[] | null {
    return this.stages.get(adminUserId)?.setlistItemIds ?? null;
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
    stage.statusReportedSocketIds.delete(socketId);
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
   *  its sequence on every outcome past the stale check, and lands it.
   *  `followCountAtRead` is the stage's follow count when the lookups were
   *  read (null: unknown, the read ids are kept as they are). When a library
   *  follow landed since and the answers hold a read of the active set list,
   *  nothing lands: it answers `vj_stale_setlist` with the state through
   *  `refuseRemoteWrite`, so the remote retries on the followed state. */
  applyRemoteCommand(
    adminUserId: string,
    name: VjRemoteCommandName,
    payload: Record<string, unknown>,
    lookups: VjLookupResults,
    now: number,
    followCountAtRead: number | null = null,
  ): VjStageOutcome {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return refuseOutcome('vj_not_attached');
    }
    const clientCheck = checkClientCommand(stage, payload);
    if (clientCheck.failure !== null) {
      return { ok: false, failure: clientCheck.failure };
    }
    if (isSetlistReadOlderThanFollow(stage, lookups, followCountAtRead)) {
      return this.refuseRemoteWrite(adminUserId, payload, 'vj_stale_setlist');
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
      { reads: lookups.setlistItems.values(), followCountAtRead },
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
    const followCountAtRead =
      this.stages.get(adminUserId)?.setlistFollowCount ?? null;
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
        this.applyRemoteCommand(
          adminUserId,
          name,
          payload,
          results,
          now,
          followCountAtRead,
        ),
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
    return this.refuseRecordedCommand(adminUserId, payload, (stage) =>
      reason === 'read_failed'
        ? vjAckFailure('vj_server_error')
        : vjAckFailure('vj_stale_command', stage.state),
    );
  }

  /** The answer of a remote command whose write before the landing failed
   *  or went stale (the Loop save of `stage:setlistSetLooping`, sequences
   *  5.6), or whose set list read a library follow overtook
   *  (`applyRemoteCommand`): the client checks rerun, the sequence recorded
   *  like `refuseRemoteRead`, then the code; `vj_stale_setlist` carries the
   *  state. */
  refuseRemoteWrite(
    adminUserId: string,
    payload: Record<string, unknown>,
    code: VjRemoteWriteRefusal,
  ): VjStageOutcome {
    return this.refuseRecordedCommand(adminUserId, payload, (stage) =>
      code === 'vj_stale_setlist'
        ? vjAckFailure(code, stage.state)
        : vjAckFailure(code),
    );
  }

  /** Reruns the client checks of a command that ends without an apply (a
   *  newer command of the same client makes it stale), records its sequence
   *  (plan note 20) and answers the refusal `failureOf` builds. */
  private refuseRecordedCommand(
    adminUserId: string,
    payload: Record<string, unknown>,
    failureOf: (stage: VjStage) => VjAckFailure,
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
    return { ok: false, failure: failureOf(stage) };
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
    stage.statusReportedSocketIds.add(socketId);
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

  /** The screen sockets `screens:setRenderMode` reaches: every connected screen, in number order. */
  renderModeTargets(
    adminUserId: string,
  ):
    | { failure: VjAckFailure; targets: [] }
    | { failure: null; targets: { socketId: string; number: number }[] } {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return { failure: vjAckFailure('vj_not_attached'), targets: [] };
    }
    const targets: { socketId: string; number: number }[] = [];
    for (const entry of stage.screens.values()) {
      if (entry.socketId !== null) {
        targets.push({ socketId: entry.socketId, number: entry.number });
      }
    }
    if (targets.length === 0) {
      return { failure: vjAckFailure('vj_no_screens_connected'), targets: [] };
    }
    targets.sort((first, second) => first.number - second.number);
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

  /** Applies a library change to every stage it touches (contract 7.10,
   *  sequences 5.9) and answers one frame per changed stage, cause
   *  `'library'`. `setlistReads` holds the gateway's follow reads by
   *  lowercased set list id; each stage follows with the item ids it held
   *  before the change, then keeps the read's item ids (an unchanged state
   *  included, so an append after the current step is remembered too). */
  applyLibraryChange(
    change: VjLibraryChange,
    now: number,
    setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  ): { adminUserId: string; frame: VjStageFrame }[] {
    const frames: { adminUserId: string; frame: VjStageFrame }[] = [];
    for (const stage of this.stages.values()) {
      const proposed = vjLibraryChangeState(
        stage.state,
        change,
        setlistReads,
        stage.setlistItemIds,
        now,
      );
      if (proposed === null) {
        rememberFollowedSetlistItemIds(stage, setlistReads);
        continue;
      }
      const outcome = landVjChange(
        stage,
        serverVjChange(proposed),
        'library',
        null,
        now,
      );
      rememberFollowedSetlistItemIds(stage, setlistReads);
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

  /** Drops one owner's stage at once, attached or idle, clearing its timers
   *  the way `sweep` does. The gateway disconnects the stage's sockets first.
   *  Answers whether a stage was in memory. */
  dropStage(adminUserId: string): boolean {
    const stage = this.stages.get(adminUserId);
    if (stage === undefined) {
      return false;
    }
    stage.timers.clear();
    this.stages.delete(adminUserId);
    return true;
  }

  /** The stages in memory for the live connections list: one owner's stage
   *  when `adminUserId` is given, else every stage. Idle stages are listed
   *  with no screens and no attached sockets. Screens come by number, each
   *  connected one only. */
  liveStages(adminUserId: string | null): VjLiveStageRead[] {
    const reads: VjLiveStageRead[] = [];
    for (const stage of this.stages.values()) {
      if (adminUserId !== null && stage.adminUserId !== adminUserId) {
        continue;
      }
      const leadSocketId = leadSocketIdOfStage(stage);
      const screens: VjLiveScreenRead[] = [];
      for (const entry of stage.screens.values()) {
        if (entry.socketId === null || entry.connectedAt === null) {
          continue;
        }
        screens.push({
          socketId: entry.socketId,
          number: entry.number,
          isLead: entry.socketId === leadSocketId,
          connectedAt: entry.connectedAt,
          isFullscreen: stage.statusReportedSocketIds.has(entry.socketId)
            ? entry.isFullscreen
            : null,
          renderer: entry.health?.renderer ?? null,
        });
      }
      screens.sort((first, second) => first.number - second.number);
      reads.push({
        adminUserId: stage.adminUserId,
        screens,
        attachedSocketIds: [...stage.attachedSocketIds],
      });
    }
    return reads;
  }

  /** How many stages in scope hold no attached socket: one owner's when
   *  `adminUserId` is given, else every stage. */
  idleStageCount(adminUserId: string | null): number {
    return this.liveStages(adminUserId).filter(
      (stage) => stage.attachedSocketIds.length === 0,
    ).length;
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
      statusReportedSocketIds: new Set(),
      setlistItemIds: null,
      setlistItemIdsSetlistId: null,
      setlistFollowCount: 0,
    };
    this.stages.set(adminUserId, stage);
    return stage;
  }

  /** Contract 7.13 adoption at revision 0, when the gateway read the restore's
   *  lookups: the restored state, the pending applyAt cleared, the set list's
   *  item ids from the restore read (sequences 5.4), timers rebuilt. A
   *  restored `playing` sequence resumes from its `stepEndsAt`; one whose
   *  step end has passed fires at once and advances one step (sequences 5.7). */
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
    const restoredRead =
      stage.state.activeSetlistId === null
        ? null
        : vjRestoreSetlistRead(input.restoreState, input.restoreReads, now);
    if (stage.state.activeSetlistId === null || restoredRead === null) {
      forgetSetlistItemIds(stage);
    } else {
      storeSetlistItemIds(
        stage,
        stage.state.activeSetlistId,
        restoredRead.itemIds,
      );
    }
    stage.timers.clear();
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
      stage.statusReportedSocketIds.delete(replacedSocketId);
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
   *  it, then syncs the timers again. The step timer needs a set list read,
   *  so it runs on its own async path (sequences 5.7). A stage evicted since
   *  does nothing. */
  private handleTimerFire(stage: VjStage, kind: VjTimerKind): void {
    if (this.stages.get(stage.adminUserId) !== stage) {
      return;
    }
    if (kind === 'setlist') {
      void this.runSetlistTimer(stage);
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

  /**
   * Sequences 5.7, the server step timer's fire: read the next step of the
   * state that fired, then land its transition with cause `setlist` at the
   * step end it fired for. After the read nothing lands when the stage left
   * the map or a newer state moved the timer target (that state armed its
   * own timer). With the target unchanged, a rejected read retries after
   * `setlistTimerRetryMs` (nothing logged, the show holds its step), and a
   * fire whose inputs moved anyway (a library follow that moved the index or
   * the items under the same clock, a Loop toggle) reads again at once, so
   * the run never stalls past its step end. A read whose item ids differ
   * from the ones the stage holds for that set list (a library write whose
   * follow has not landed) lands that follow first with cause `library` and
   * reads again at once. Never rejects: a throw logs the
   * stage owner's id only and retries after `setlistTimerRetryMs` while the
   * target is unchanged.
   */
  private async runSetlistTimer(stage: VjStage): Promise<void> {
    const fired: VjSetlistTimerFire = {
      state: stage.state,
      setlistItemIds: stage.setlistItemIds,
    };
    try {
      await this.advanceSetlistTimer(stage, fired);
    } catch {
      this.logger.error(
        `VJ sequence step timer landing failed: user ${stage.adminUserId}`,
      );
      if (this.isSetlistTimerTargetKept(stage, fired)) {
        stage.timers.retry(
          'setlist',
          Date.now() + VJ_LIMITS.setlistTimerRetryMs,
        );
      }
    }
  }

  /** Whether the stage is still in the map with the timer target the fire
   *  served. */
  private isSetlistTimerTargetKept(
    stage: VjStage,
    fired: VjSetlistTimerFire,
  ): boolean {
    return (
      this.stages.get(stage.adminUserId) === stage &&
      vjSetlistTimerTargetAt(stage.state) ===
        vjSetlistTimerTargetAt(fired.state)
    );
  }

  /** The body of `runSetlistTimer`: read, the stale checks, then the landing
   *  and its broadcast. */
  private async advanceSetlistTimer(
    stage: VjStage,
    fired: VjSetlistTimerFire,
  ): Promise<void> {
    const position = vjSetlistTimerReadPosition(fired.state);
    const setlistId = fired.state.activeSetlistId;
    if (position === null || setlistId === null) {
      return;
    }
    const lookup: VjCommandLookup = {
      kind: 'setlistItem',
      setlistId,
      position,
    };
    let read: VjSetlistRead | null = null;
    let isReadRejected = false;
    try {
      const results = await resolveVjLookups(this.stageReads, [lookup]);
      read =
        results.setlistItems.get(vjSetlistItemKey(setlistId, position)) ?? null;
    } catch {
      isReadRejected = true;
    }
    if (!this.isSetlistTimerTargetKept(stage, fired)) {
      return;
    }
    if (isReadRejected) {
      stage.timers.retry('setlist', Date.now() + VJ_LIMITS.setlistTimerRetryMs);
      return;
    }
    if (hasSetlistTimerStateMoved(fired, stage)) {
      stage.timers.retry('setlist', Date.now());
      return;
    }
    if (
      read !== null &&
      hasUnfollowedItemEdit(stage, setlistId, read.itemIds)
    ) {
      this.landTimerSetlistFollow(stage, setlistId, read);
      stage.timers.retry('setlist', Date.now());
      return;
    }
    const transition = vjSetlistTimerTransition(stage.state, read);
    if (transition === null) {
      return;
    }
    const outcome = landVjChange(
      stage,
      vjSetlistTransitionChange(
        transition,
        [lookup],
        fired.state.setlistPlayback.stepEndsAt,
      ),
      VJ_TIMER_CAUSES.setlist,
      null,
      Date.now(),
      { reads: [read], followCountAtRead: null },
    );
    if (outcome.frame !== null) {
      this.broadcaster?.broadcastState(stage.adminUserId, outcome.frame);
    }
  }

  /** The step timer's read answered item ids newer than the stage holds (a
   *  library write committed and its follow has not landed): the follow
   *  lands first with cause `library` (sequences 7) and the read's ids are
   *  stored as a follow's, so the step after the edit is the one that
   *  plays. The library follow that lands later finds nothing to move. */
  private landTimerSetlistFollow(
    stage: VjStage,
    setlistId: string,
    read: VjSetlistRead,
  ): void {
    const followed = vjSetlistFollowState(stage.state, {
      setlistId,
      previousItemIds: stage.setlistItemIds,
      read: { itemIds: read.itemIds, isLooping: read.isLooping },
    });
    const outcome = landVjChange(
      stage,
      serverVjChange(followed),
      'library',
      null,
      Date.now(),
      { reads: [read], followCountAtRead: null },
    );
    stage.setlistFollowCount += 1;
    if (outcome.frame !== null) {
      this.broadcaster?.broadcastState(stage.adminUserId, outcome.frame);
    }
  }
}
