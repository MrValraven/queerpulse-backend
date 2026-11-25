/**
 * Pulse Live (`quizshow`) engine, the session tools a host runs beside the
 * phase machine: refreshing a lobby with the latest quiz edits, locking
 * joins, the live-state half of the guest push, and the paired screens and
 * helper remotes (contract 4.3, 6.5, 6.8, 6.10, 6.15). Pure: every time comes
 * in as a `now` argument. The gateway and the services call these functions
 * through the runtime; this module imports neither. Commands that end with
 * `hostActed` get their one checkpoint from it, last.
 */
import {
  QUIZSHOW_LIMITS,
  type QuizshowErrorCode,
  type QuizshowPairedDevice,
  type QuizshowSessionStatus,
} from './quizshow.contract';
import {
  checkpoint,
  hostActed,
  noteHostCommand,
  type QuizshowHostOutcome,
} from './quizshow-engine-phases';
import {
  isActivePlayer,
  persist,
  refuse,
  succeed,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLivePairedDevice,
  QuizshowLiveState,
} from './quizshow-engine-types';
import { isAdultsOnlySession } from './quizshow-play-rules';
import type { QuizshowSessionSnapshot } from './quizshow-snapshot';
import {
  emptyWheelProgress,
  isWheelRoundKind,
  progressCursorFields,
} from './quizshow-wheel';

type QuizshowAddPairedDeviceOutcome = QuizshowCommandOutcome<{
  isNoop: boolean;
  device: QuizshowPairedDevice;
}>;

/** The most entries `pairedDevices` keeps; revoked ones past it go, oldest revocation first. */
const PAIRED_DEVICES_KEPT_MAX = 4 * QUIZSHOW_LIMITS.pairedDevicesMax;

/**
 * Drops the earliest revoked entries until the list fits
 * `PAIRED_DEVICES_KEPT_MAX`, so pairing and unpairing over a long night
 * cannot grow the live state without end. Live entries are never dropped;
 * at most `pairedDevicesMax` of them exist, well under the cap. Returns the
 * dropped pairing ids, so the stored array drops the same entries.
 */
function pruneRevokedPairedDevices(state: QuizshowLiveState): string[] {
  const droppedPairingIds: string[] = [];
  while (state.pairedDevices.length > PAIRED_DEVICES_KEPT_MAX) {
    let oldestRevokedIndex = -1;
    let oldestRevokedAt = Number.POSITIVE_INFINITY;
    for (let index = 0; index < state.pairedDevices.length; index += 1) {
      const revokedAt = state.pairedDevices[index]?.revokedAt ?? null;
      // Strictly earlier, so of two equal times the one higher in the list goes first.
      if (revokedAt !== null && revokedAt < oldestRevokedAt) {
        oldestRevokedIndex = index;
        oldestRevokedAt = revokedAt;
      }
    }
    if (oldestRevokedIndex === -1) break;
    const [droppedDevice] = state.pairedDevices.splice(oldestRevokedIndex, 1);
    if (droppedDevice !== undefined) {
      droppedPairingIds.push(droppedDevice.pairingId);
    }
  }
  return droppedPairingIds;
}

function isOpenStatus(status: QuizshowSessionStatus): boolean {
  return status === 'lobby' || status === 'running' || status === 'paused';
}

/** The view the remote lists for one unrevoked device; twin of `buildPairedDevices` in quizshow-frames.ts, so change both together. */
function toPairedDeviceView(
  device: QuizshowLivePairedDevice,
): QuizshowPairedDevice {
  return {
    pairingId: device.pairingId,
    kind: device.kind,
    helperName: device.kind === 'helper' ? device.helperName : null,
    pairedAt: device.pairedAt,
    isConnected: device.connectedSocketCount > 0,
  };
}

/** A joker may sit on this row of the snapshot: a playable round (any kind but a wheel) that allows a joker. */
function isJokerRoundIndex(
  snapshot: QuizshowSessionSnapshot,
  roundIndex: number,
): boolean {
  const round = snapshot.rounds[roundIndex];
  return (
    round !== undefined &&
    !isWheelRoundKind(round.kind) &&
    round.settings.isJokerAllowed
  );
}

/**
 * A lobby joker names a round index of the old snapshot. When the new rounds
 * no longer hold a joker-allowed playable row at that index, the joker comes
 * back to its holder (player in solo play, team in teams play), so it never
 * doubles a round nobody picked it for. Returns the writes that store it.
 */
function returnStrandedJokers(
  state: QuizshowLiveState,
  snapshot: QuizshowSessionSnapshot,
): QuizshowEngineEffect[] {
  const effects: QuizshowEngineEffect[] = [];
  const jokerReset = { hasUsedJoker: false, jokerRoundIndex: null };
  for (const player of state.players.values()) {
    if (
      player.jokerRoundIndex === null ||
      isJokerRoundIndex(snapshot, player.jokerRoundIndex)
    ) {
      continue;
    }
    player.hasUsedJoker = false;
    player.jokerRoundIndex = null;
    effects.push(
      persist({
        type: 'update_player',
        playerId: player.playerId,
        fields: { ...jokerReset },
      }),
    );
  }
  for (const team of state.teams.values()) {
    if (
      team.jokerRoundIndex === null ||
      isJokerRoundIndex(snapshot, team.jokerRoundIndex)
    ) {
      continue;
    }
    team.hasUsedJoker = false;
    team.jokerRoundIndex = null;
    effects.push(
      persist({
        type: 'update_team',
        teamId: team.teamId,
        fields: { ...jokerReset },
      }),
    );
  }
  return effects;
}

/**
 * Swaps a lobby's snapshot for one built from the latest quiz (contract 6.10).
 * An equal `sourceUpdatedAt` means the lobby already runs that version. The
 * phase id stays, so a remote's next command is not stale; the round count,
 * up next and the adults flag follow the new rounds, and every viewer gets a
 * fresh `session:state` through `state_reset`. The 18+ consent is asked only
 * on a first join, so a lobby that people already joined keeps its adults
 * flag off; an empty lobby may turn 18+, and turning it off is always fine.
 */
export function hostRefreshQuiz(
  state: QuizshowLiveState,
  snapshot: QuizshowSessionSnapshot,
  isScopeAdultsOnly: boolean,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (state.status !== 'lobby') {
    return refuse('quizshow_not_in_lobby', state, true);
  }
  if (snapshot.sourceUpdatedAt === state.snapshot.sourceUpdatedAt) {
    return hostActed(state, now, [], true);
  }
  const isAdultsOnly = isAdultsOnlySession(isScopeAdultsOnly, snapshot);
  const hasActivePlayer = [...state.players.values()].some(isActivePlayer);
  if (!state.isAdultsOnly && isAdultsOnly && hasActivePlayer) {
    return refuse('quizshow_refresh_adults_lobby_joined', state, true);
  }
  const jokerEffects = returnStrandedJokers(state, snapshot);
  state.snapshot = snapshot;
  state.wheelProgress = emptyWheelProgress();
  state.isAdultsOnly = isAdultsOnly;
  state.cursor = {
    ...state.cursor,
    ...progressCursorFields(snapshot.rounds, state.wheelProgress, 'lobby'),
  };
  return hostActed(
    state,
    now,
    [
      persist({ type: 'replace_snapshot' }),
      ...jokerEffects,
      { kind: 'state_reset', scope: 'everyone' },
    ],
    false,
  );
}

/** Closes or opens the session to new players in any open status; a rejoin still passes (contract 6.15). */
export function hostSetJoinLock(
  state: QuizshowLiveState,
  isLocked: boolean,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  if (state.isJoinLocked === isLocked) return hostActed(state, now, [], true);
  state.isJoinLocked = isLocked;
  return hostActed(
    state,
    now,
    [persist({ type: 'set_session_flags' }), { kind: 'flags_changed' }],
    false,
  );
}

/**
 * The live-state checks of `host:notifyGuests`, in the contract's order
 * (6.8). The sessions service runs the cooldown query after these pass, so
 * this returns the first refusal code, or null when the push may go out.
 */
export function guestPushRefusal(
  state: QuizshowLiveState,
): QuizshowErrorCode | null {
  if (state.status !== 'lobby') return 'quizshow_not_in_lobby';
  if (state.kind !== 'event') return 'quizshow_guest_push_needs_event';
  if (state.isPractice) return 'quizshow_guest_push_practice';
  if (state.guestPushSentAt !== null) return 'quizshow_guest_push_already_sent';
  return null;
}

/**
 * Mirrors a guest push the sessions service sent and stored. The hosts room
 * gets a fresh `session:state`, so every remote shows "Guests have the code".
 */
export function noteGuestPushSent(
  state: QuizshowLiveState,
  sentAt: number,
): QuizshowCommandOutcome {
  state.guestPushSentAt = sentAt;
  return succeed({}, [{ kind: 'state_reset', scope: 'hosts' }]);
}

/**
 * Appends a screen or helper remote the gateway just paired (contract 6.5).
 * Revoked pairings stay in the list for the record and free their seat,
 * until the list passes `PAIRED_DEVICES_KEPT_MAX` and the oldest go.
 */
export function hostAddPairedDevice(
  state: QuizshowLiveState,
  device: QuizshowLivePairedDevice,
  now: number,
): QuizshowAddPairedDeviceOutcome {
  noteHostCommand(state, now);
  const unrevokedCount = state.pairedDevices.filter(
    (pairedDevice) => pairedDevice.revokedAt === null,
  ).length;
  if (unrevokedCount >= QUIZSHOW_LIMITS.pairedDevicesMax) {
    return refuse('quizshow_paired_devices_full', state, false);
  }
  const addedDevice: QuizshowLivePairedDevice = { ...device };
  state.pairedDevices.push(addedDevice);
  const droppedPairingIds = pruneRevokedPairedDevices(state);
  return succeed({ isNoop: false, device: toPairedDeviceView(addedDevice) }, [
    persist({
      type: 'add_paired_device',
      device: addedDevice,
      droppedPairingIds,
    }),
    { kind: 'devices_changed' },
    checkpoint(),
  ]);
}

/** Unpairs a screen or helper; the gateway then tells its sockets and disconnects them (contract 6.5). */
export function hostRevokePairedDevice(
  state: QuizshowLiveState,
  pairingId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const device = state.pairedDevices.find(
    (pairedDevice) => pairedDevice.pairingId === pairingId,
  );
  if (device === undefined || device.revokedAt !== null) {
    return refuse('quizshow_device_not_found', state, false);
  }
  device.revokedAt = now;
  return hostActed(
    state,
    now,
    [
      persist({ type: 'revoke_paired_device', pairingId, revokedAt: now }),
      { kind: 'devices_changed' },
    ],
    false,
  );
}
