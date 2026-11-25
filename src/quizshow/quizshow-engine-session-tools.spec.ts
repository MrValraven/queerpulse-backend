import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowAckFailure,
  type QuizshowContentLabel,
} from './quizshow.contract';
import {
  guestPushRefusal,
  hostAddPairedDevice,
  hostRefreshQuiz,
  hostRevokePairedDevice,
  hostSetJoinLock,
  noteGuestPushSent,
} from './quizshow-engine-session-tools';
import { createLobbyState, setSessionStatus } from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowLivePairedDevice,
  QuizshowLivePlayer,
  QuizshowLiveState,
} from './quizshow-engine-types';
import type {
  QuizshowSessionSnapshot,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const LOBBY_OPENED_AT = 1_000;
const NOW = 5_000;

function snapshotRound(
  roundId: string,
  contentLabel: QuizshowContentLabel = 'none',
): QuizshowSnapshotRound {
  return {
    id: roundId,
    kind: 'quiz',
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel,
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
      isWarmUp: false,
      talkSeconds: 0,
    },
    questions: [
      {
        id: `${roundId}-question`,
        type: 'true_false',
        prompt: { en: 'Is it true?', pt: 'É verdade?' },
        mediaRef: null,
        mediaUrl: null,
        mediaAlt: { en: '', pt: '' },
        mediaReveal: 'instant',
        revealNote: { en: '', pt: '' },
        numberUnit: { en: '', pt: '' },
        timeLimitSeconds: null,
        points: 1000,
        options: [],
        answer: { isTrue: true },
        acceptedAnswers: [],
        shownOptions: null,
      },
    ],
  };
}

const FIRST_SNAPSHOT: QuizshowSessionSnapshot = {
  title: 'Pride night quiz',
  languages: 'both',
  screenLanguage: 'en',
  rounds: [snapshotRound('round-one')],
  sourceUpdatedAt: '2026-11-24T10:00:00.000Z',
};

const EDITED_SNAPSHOT: QuizshowSessionSnapshot = {
  ...FIRST_SNAPSHOT,
  rounds: [
    snapshotRound('round-one'),
    snapshotRound('round-two'),
    snapshotRound('round-three'),
  ],
  sourceUpdatedAt: '2026-11-24T12:00:00.000Z',
};

function lobbyState(
  overrides: Partial<Pick<QuizshowLiveState, 'kind' | 'isPractice'>> = {},
): QuizshowLiveState {
  const isGame = overrides.kind === 'game';
  return createLobbyState({
    sessionId: 'session-1',
    eventId: isGame ? null : 'event-1',
    eventSlug: isGame ? null : 'pride-night',
    eventTitle: isGame ? null : 'Pride night',
    kind: overrides.kind ?? 'event',
    gameId: isGame ? 'game-1' : null,
    isAdultsOnly: false,
    hostUserId: 'host-user',
    openedByUserId: 'host-user',
    joinCode: 'ABC234',
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: true,
    isPractice: overrides.isPractice ?? false,
    snapshot: FIRST_SNAPSHOT,
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: LOBBY_OPENED_AT,
  });
}

function addPlayer(
  state: QuizshowLiveState,
  playerId: string,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  const player: QuizshowLivePlayer = {
    playerId,
    userId: `${playerId}-user`,
    screenName: `${playerId} name`,
    teamId: null,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: LOBBY_OPENED_AT,
    removedAt: null,
    connectedSocketCount: 1,
    disconnectedAt: null,
    leftAt: null,
    ...overrides,
  };
  state.players.set(playerId, player);
  return player;
}

const ADULTS_SNAPSHOT: QuizshowSessionSnapshot = {
  ...EDITED_SNAPSHOT,
  rounds: [snapshotRound('round-one', 'adults')],
};

function pairedDevice(
  pairingId: string,
  overrides: Partial<QuizshowLivePairedDevice> = {},
): QuizshowLivePairedDevice {
  return {
    pairingId,
    kind: 'screen',
    helperUserId: null,
    helperName: null,
    pairedAt: LOBBY_OPENED_AT,
    revokedAt: null,
    connectedSocketCount: 0,
    ...overrides,
  };
}

function failureOf<Success extends object>(
  outcome: QuizshowCommandOutcome<Success>,
): QuizshowAckFailure {
  if (outcome.ok) throw new Error('Expected a refusal.');
  return outcome.failure;
}

function successOf<Success extends object>(
  outcome: QuizshowCommandOutcome<Success>,
): Success {
  if (!outcome.ok) throw new Error(`Refused with ${outcome.failure.code}.`);
  return outcome.success;
}

describe('hostRefreshQuiz', () => {
  it('is a no-op when the stamps are equal', () => {
    const state = lobbyState();
    const outcome = hostRefreshQuiz(state, { ...FIRST_SNAPSHOT }, false, NOW);
    expect(successOf(outcome)).toEqual({ isNoop: true });
    expect(outcome.effects).toEqual([
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);
    expect(state.snapshot).toBe(FIRST_SNAPSHOT);
  });

  it('swaps the snapshot and resets the progress on a new stamp', () => {
    const state = lobbyState();
    state.wheelProgress.playedRoundIndexes.push(0);
    const phaseIdBefore = state.cursor.phaseId;
    const outcome = hostRefreshQuiz(state, EDITED_SNAPSHOT, false, NOW);
    expect(successOf(outcome)).toEqual({ isNoop: false });
    expect(state.snapshot).toBe(EDITED_SNAPSHOT);
    expect(state.wheelProgress.playedRoundIndexes).toEqual([]);
    expect(state.cursor.phaseId).toBe(phaseIdBefore);
    expect(state.cursor.roundCount).toBe(3);
    expect(state.lastHostCommandAt).toBe(NOW);
    expect(outcome.effects).toEqual([
      { kind: 'persist', operation: { type: 'replace_snapshot' } },
      { kind: 'state_reset', scope: 'everyone' },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);
  });

  it('gives back a joker whose round index no longer names a joker round, and stores it', () => {
    const state = lobbyState();
    const roundTwo = snapshotRound('round-two');
    const noJokerRound: QuizshowSnapshotRound = {
      ...roundTwo,
      settings: { ...roundTwo.settings, isJokerAllowed: false },
    };
    const snapshot: QuizshowSessionSnapshot = {
      ...EDITED_SNAPSHOT,
      rounds: [snapshotRound('round-one'), noJokerRound],
    };
    addPlayer(state, 'player-kept', {
      hasUsedJoker: true,
      jokerRoundIndex: 0,
    });
    addPlayer(state, 'player-not-allowed', {
      hasUsedJoker: true,
      jokerRoundIndex: 1,
    });
    addPlayer(state, 'player-gone', { hasUsedJoker: true, jokerRoundIndex: 4 });
    state.teams.set('team-gone', {
      teamId: 'team-gone',
      name: 'Team gone',
      colorKey: 'circle',
      score: 0,
      hasUsedJoker: true,
      jokerRoundIndex: 3,
      createdAt: LOBBY_OPENED_AT,
      isHostMade: true,
    });

    const outcome = hostRefreshQuiz(state, snapshot, false, NOW);

    expect(successOf(outcome)).toEqual({ isNoop: false });
    expect(state.players.get('player-kept')).toMatchObject({
      hasUsedJoker: true,
      jokerRoundIndex: 0,
    });
    for (const playerId of ['player-not-allowed', 'player-gone']) {
      expect(state.players.get(playerId)).toMatchObject({
        hasUsedJoker: false,
        jokerRoundIndex: null,
      });
    }
    expect(state.teams.get('team-gone')).toMatchObject({
      hasUsedJoker: false,
      jokerRoundIndex: null,
    });
    const jokerReset = { hasUsedJoker: false, jokerRoundIndex: null };
    expect(outcome.effects).toEqual([
      { kind: 'persist', operation: { type: 'replace_snapshot' } },
      {
        kind: 'persist',
        operation: {
          type: 'update_player',
          playerId: 'player-not-allowed',
          fields: jokerReset,
        },
      },
      {
        kind: 'persist',
        operation: {
          type: 'update_player',
          playerId: 'player-gone',
          fields: jokerReset,
        },
      },
      {
        kind: 'persist',
        operation: {
          type: 'update_team',
          teamId: 'team-gone',
          fields: jokerReset,
        },
      },
      { kind: 'state_reset', scope: 'everyone' },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);
  });

  it('is refused while the session runs', () => {
    const state = lobbyState();
    setSessionStatus(state, 'running');
    const outcome = hostRefreshQuiz(state, EDITED_SNAPSHOT, false, NOW);
    const failure = failureOf(outcome);
    expect(failure.code).toBe('quizshow_not_in_lobby');
    expect(failure.cursor).toEqual(state.cursor);
    expect(state.snapshot).toBe(FIRST_SNAPSHOT);
  });

  it('is refused while the session is paused', () => {
    const state = lobbyState();
    setSessionStatus(state, 'paused');
    const outcome = hostRefreshQuiz(state, EDITED_SNAPSHOT, false, NOW);
    expect(failureOf(outcome).code).toBe('quizshow_not_in_lobby');
    expect(state.snapshot).toBe(FIRST_SNAPSHOT);
  });

  it('refuses to turn a lobby 18+ once someone joined', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1');
    const outcome = hostRefreshQuiz(state, ADULTS_SNAPSHOT, false, NOW);
    const failure = failureOf(outcome);
    expect(failure.code).toBe('quizshow_refresh_adults_lobby_joined');
    expect(failure.cursor).toEqual(state.cursor);
    expect(state.isAdultsOnly).toBe(false);
    expect(state.snapshot).toBe(FIRST_SNAPSHOT);
  });

  it('refuses the same flip when the 18+ flag comes from the scope', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1');
    const outcome = hostRefreshQuiz(state, EDITED_SNAPSHOT, true, NOW);
    expect(failureOf(outcome).code).toBe(
      'quizshow_refresh_adults_lobby_joined',
    );
  });

  it('turns a lobby 18+ when only removed or left players are in it', () => {
    const state = lobbyState();
    addPlayer(state, 'player-removed', { removedAt: LOBBY_OPENED_AT });
    addPlayer(state, 'player-left', { leftAt: LOBBY_OPENED_AT });
    const outcome = hostRefreshQuiz(state, ADULTS_SNAPSHOT, false, NOW);
    expect(successOf(outcome)).toEqual({ isNoop: false });
    expect(state.isAdultsOnly).toBe(true);
  });

  it('turns an empty lobby 18+', () => {
    const state = lobbyState();
    const outcome = hostRefreshQuiz(state, ADULTS_SNAPSHOT, false, NOW);
    expect(successOf(outcome)).toEqual({ isNoop: false });
    expect(state.isAdultsOnly).toBe(true);
    expect(state.snapshot).toBe(ADULTS_SNAPSHOT);
  });

  it('turns an 18+ lobby back off with players in it', () => {
    const state = lobbyState();
    hostRefreshQuiz(state, ADULTS_SNAPSHOT, false, NOW);
    addPlayer(state, 'player-1');
    const calmerSnapshot: QuizshowSessionSnapshot = {
      ...EDITED_SNAPSHOT,
      sourceUpdatedAt: '2026-11-24T13:00:00.000Z',
    };
    const outcome = hostRefreshQuiz(state, calmerSnapshot, false, NOW);
    expect(successOf(outcome)).toEqual({ isNoop: false });
    expect(state.isAdultsOnly).toBe(false);
  });

  it('keeps an 18+ lobby 18+ with players in it', () => {
    const state = lobbyState();
    hostRefreshQuiz(state, ADULTS_SNAPSHOT, false, NOW);
    addPlayer(state, 'player-1');
    const nextAdultsSnapshot: QuizshowSessionSnapshot = {
      ...ADULTS_SNAPSHOT,
      sourceUpdatedAt: '2026-11-24T13:00:00.000Z',
    };
    const outcome = hostRefreshQuiz(state, nextAdultsSnapshot, false, NOW);
    expect(successOf(outcome)).toEqual({ isNoop: false });
    expect(state.isAdultsOnly).toBe(true);
  });

  it('sets the adults flag from the new snapshot and the scope', () => {
    const state = lobbyState();
    hostRefreshQuiz(state, ADULTS_SNAPSHOT, false, NOW);
    expect(state.isAdultsOnly).toBe(true);

    const calmerSnapshot: QuizshowSessionSnapshot = {
      ...EDITED_SNAPSHOT,
      sourceUpdatedAt: '2026-11-24T13:00:00.000Z',
    };
    hostRefreshQuiz(state, calmerSnapshot, false, NOW);
    expect(state.isAdultsOnly).toBe(false);

    const scopeAdultsSnapshot: QuizshowSessionSnapshot = {
      ...EDITED_SNAPSHOT,
      sourceUpdatedAt: '2026-11-24T14:00:00.000Z',
    };
    hostRefreshQuiz(state, scopeAdultsSnapshot, true, NOW);
    expect(state.isAdultsOnly).toBe(true);
  });
});

describe('hostSetJoinLock', () => {
  it('locks, treats the same value as a no-op, then unlocks', () => {
    const state = lobbyState();
    const lockOutcome = hostSetJoinLock(state, true, NOW);
    expect(successOf(lockOutcome)).toEqual({ isNoop: false });
    expect(state.isJoinLocked).toBe(true);
    expect(lockOutcome.effects).toEqual([
      { kind: 'persist', operation: { type: 'set_session_flags' } },
      { kind: 'flags_changed' },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);

    const againOutcome = hostSetJoinLock(state, true, NOW);
    expect(successOf(againOutcome)).toEqual({ isNoop: true });
    expect(againOutcome.effects).toEqual([
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);

    const unlockOutcome = hostSetJoinLock(state, false, NOW);
    expect(successOf(unlockOutcome)).toEqual({ isNoop: false });
    expect(state.isJoinLocked).toBe(false);
  });

  it('works while running and is refused once the session ended', () => {
    const state = lobbyState();
    setSessionStatus(state, 'running');
    expect(successOf(hostSetJoinLock(state, true, NOW))).toEqual({
      isNoop: false,
    });
    setSessionStatus(state, 'finished');
    expect(failureOf(hostSetJoinLock(state, false, NOW)).code).toBe(
      'quizshow_session_ended',
    );
  });
});

describe('guest push', () => {
  it('refuses outside the lobby first', () => {
    const state = lobbyState({ kind: 'game', isPractice: true });
    state.guestPushSentAt = NOW;
    setSessionStatus(state, 'running');
    expect(guestPushRefusal(state)).toBe('quizshow_not_in_lobby');
  });

  it('then refuses a game session', () => {
    const state = lobbyState({ kind: 'game', isPractice: true });
    state.guestPushSentAt = NOW;
    expect(guestPushRefusal(state)).toBe('quizshow_guest_push_needs_event');
  });

  it('then refuses a practice lobby', () => {
    const state = lobbyState({ isPractice: true });
    state.guestPushSentAt = NOW;
    expect(guestPushRefusal(state)).toBe('quizshow_guest_push_practice');
  });

  it('then refuses a second push', () => {
    const state = lobbyState();
    state.guestPushSentAt = NOW;
    expect(guestPushRefusal(state)).toBe('quizshow_guest_push_already_sent');
  });

  it('passes an event lobby that has not pushed yet', () => {
    expect(guestPushRefusal(lobbyState())).toBeNull();
  });

  it('records the push and refreshes the hosts', () => {
    const state = lobbyState();
    const outcome = noteGuestPushSent(state, NOW);
    expect(outcome.ok).toBe(true);
    expect(state.guestPushSentAt).toBe(NOW);
    expect(outcome.effects).toEqual([{ kind: 'state_reset', scope: 'hosts' }]);
    expect(guestPushRefusal(state)).toBe('quizshow_guest_push_already_sent');
  });
});

describe('paired devices', () => {
  it('adds a device and answers with its view', () => {
    const state = lobbyState();
    const helper = pairedDevice('pairing-helper', {
      kind: 'helper',
      helperUserId: 'helper-user',
      helperName: 'Sam',
    });
    const outcome = hostAddPairedDevice(state, helper, NOW);
    expect(successOf(outcome)).toEqual({
      isNoop: false,
      device: {
        pairingId: 'pairing-helper',
        kind: 'helper',
        helperName: 'Sam',
        pairedAt: LOBBY_OPENED_AT,
        isConnected: false,
      },
    });
    expect(state.pairedDevices).toHaveLength(1);
    expect(outcome.effects).toEqual([
      {
        kind: 'persist',
        operation: {
          type: 'add_paired_device',
          device: helper,
          droppedPairingIds: [],
        },
      },
      { kind: 'devices_changed' },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);
  });

  it('caps unrevoked devices at the limit and counts only unrevoked ones', () => {
    expect(QUIZSHOW_LIMITS.pairedDevicesMax).toBe(6);
    const state = lobbyState();
    for (let deviceNumber = 1; deviceNumber <= 6; deviceNumber += 1) {
      const outcome = hostAddPairedDevice(
        state,
        pairedDevice(`pairing-${deviceNumber}`),
        NOW,
      );
      expect(outcome.ok).toBe(true);
    }
    const seventhOutcome = hostAddPairedDevice(
      state,
      pairedDevice('pairing-7'),
      NOW,
    );
    expect(failureOf(seventhOutcome).code).toBe('quizshow_paired_devices_full');
    expect(state.pairedDevices).toHaveLength(6);

    expect(hostRevokePairedDevice(state, 'pairing-1', NOW).ok).toBe(true);
    expect(hostAddPairedDevice(state, pairedDevice('pairing-7'), NOW).ok).toBe(
      true,
    );
    expect(state.pairedDevices).toHaveLength(7);
  });

  it('keeps at most four times the device limit, dropping the earliest revoked entries and never a live one', () => {
    const keptMax = 4 * QUIZSHOW_LIMITS.pairedDevicesMax;
    const state = lobbyState();
    const liveScreen = pairedDevice('pairing-live');
    state.pairedDevices.push(liveScreen);
    // Revoked later the further down the list, so the first ones are the oldest.
    for (let deviceNumber = 1; deviceNumber < keptMax; deviceNumber += 1) {
      state.pairedDevices.push(
        pairedDevice(`pairing-revoked-${deviceNumber}`, {
          revokedAt: NOW + deviceNumber,
        }),
      );
    }
    expect(state.pairedDevices).toHaveLength(keptMax);

    const outcome = hostAddPairedDevice(
      state,
      pairedDevice('pairing-new'),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    // The stored array drops the same entry the memory list dropped.
    expect(outcome.effects).toContainEqual({
      kind: 'persist',
      operation: {
        type: 'add_paired_device',
        device: pairedDevice('pairing-new'),
        droppedPairingIds: ['pairing-revoked-1'],
      },
    });
    expect(state.pairedDevices).toHaveLength(keptMax);
    const pairingIds = state.pairedDevices.map((device) => device.pairingId);
    expect(pairingIds).not.toContain('pairing-revoked-1');
    expect(pairingIds).toContain('pairing-revoked-2');
    expect(pairingIds).toContain('pairing-live');
    expect(pairingIds[pairingIds.length - 1]).toBe('pairing-new');
    expect(state.pairedDevices[0]).toBe(liveScreen);
  });

  it('revokes once and refuses the second revoke', () => {
    const state = lobbyState();
    hostAddPairedDevice(state, pairedDevice('pairing-screen'), NOW);
    const revokedAt = NOW + 1_000;
    const firstOutcome = hostRevokePairedDevice(
      state,
      'pairing-screen',
      revokedAt,
    );
    expect(successOf(firstOutcome)).toEqual({ isNoop: false });
    expect(state.pairedDevices[0]?.revokedAt).toBe(revokedAt);
    expect(firstOutcome.effects).toEqual([
      {
        kind: 'persist',
        operation: {
          type: 'revoke_paired_device',
          pairingId: 'pairing-screen',
          revokedAt,
        },
      },
      { kind: 'devices_changed' },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);

    const secondOutcome = hostRevokePairedDevice(
      state,
      'pairing-screen',
      revokedAt,
    );
    expect(failureOf(secondOutcome).code).toBe('quizshow_device_not_found');
  });

  it('refuses an unknown pairing', () => {
    const state = lobbyState();
    expect(
      failureOf(hostRevokePairedDevice(state, 'pairing-unknown', NOW)).code,
    ).toBe('quizshow_device_not_found');
  });
});
