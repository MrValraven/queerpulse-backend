import {
  createVjStageState,
  type VjSetlistClockStamp,
  type VjStageState,
  type VjTempo,
} from '../vj.contract';
import {
  stampVjChangeTimes,
  vjApplyAtFor,
  vjAttachApplyAt,
  type VjApplyAtInput,
} from './vj-quantize';
import { withVjLiveSource } from './vj-rule-kit';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const SETLIST_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_ID = '55555555-5555-4555-8555-555555555555';

const KEEP_CLOCK: VjSetlistClockStamp = { kind: 'keep' };

/** A stage at time 0 with the grid's "1" on 0. */
function stageWithTempo(tempo: Partial<VjTempo> = {}): VjStageState {
  const state = createVjStageState(STAGE_EPOCH, 0);
  return {
    ...state,
    tempo: {
      bpm: 120,
      downbeatAt: 0,
      quantize: 'beat',
      source: 'manual',
      ...tempo,
    },
  };
}

function withClip(state: VjStageState, clipId: string): VjStageState {
  return withVjLiveSource(state, { kind: 'clip', clipId });
}

function withEffectsSpeed(state: VjStageState): VjStageState {
  return { ...state, effects: { ...state.effects, speed: 2 } };
}

function applyAtInput(
  previous: VjStageState,
  next: VjStageState,
  overrides: Partial<VjApplyAtInput> = {},
): VjApplyAtInput {
  return {
    previous,
    next,
    isLookSwitch: false,
    isImmediate: false,
    cause: 'command',
    pendingApplyAt: null,
    now: 0,
    scheduledAt: null,
    ...overrides,
  };
}

describe('vjApplyAtFor', () => {
  it('answers null for an unquantized change with nothing pending', () => {
    const state = stageWithTempo();
    expect(
      vjApplyAtFor(applyAtInput(state, withEffectsSpeed(state), { now: 1400 })),
    ).toBeNull();
    const quantizeOff = stageWithTempo({ quantize: 'off' });
    expect(
      vjApplyAtFor(
        applyAtInput(quantizeOff, withClip(quantizeOff, CLIP_ID), {
          now: 1400,
        }),
      ),
    ).toBeNull();
    expect(
      vjApplyAtFor(
        applyAtInput(state, withEffectsSpeed(state), {
          now: 1400,
          pendingApplyAt: 1400,
        }),
      ),
    ).toBeNull();
  });

  it('lands a clip change on the next beat with the 150 ms lead', () => {
    const state = stageWithTempo();
    expect(
      vjApplyAtFor(
        applyAtInput(state, withClip(state, CLIP_ID), { now: 1300 }),
      ),
    ).toBe(1500);
    expect(
      vjApplyAtFor(
        applyAtInput(state, withClip(state, CLIP_ID), { now: 1360 }),
      ),
    ).toBe(2000);
    const barState = stageWithTempo({ quantize: 'bar' });
    expect(
      vjApplyAtFor(
        applyAtInput(barState, withClip(barState, CLIP_ID), { now: 1300 }),
      ),
    ).toBe(2000);
    const live = withClip(state, CLIP_ID);
    expect(
      vjApplyAtFor(applyAtInput(live, withClip(live, CLIP_ID), { now: 1300 })),
    ).toBe(1500);
  });

  it('lands a recall on the grid even when the source stays', () => {
    const state = stageWithTempo();
    expect(
      vjApplyAtFor(
        applyAtInput(state, withEffectsSpeed(state), {
          isLookSwitch: true,
          now: 1300,
        }),
      ),
    ).toBe(1500);
  });

  it('keeps applyAt monotonic across a pending change', () => {
    const state = stageWithTempo({ bpm: 100 });
    expect(
      vjApplyAtFor(
        applyAtInput(state, withEffectsSpeed(state), {
          now: 4000,
          pendingApplyAt: 5000,
        }),
      ),
    ).toBe(5000);
    expect(
      vjApplyAtFor(
        applyAtInput(state, withClip(state, CLIP_ID), {
          now: 4100,
          pendingApplyAt: 5000,
        }),
      ),
    ).toBe(5000);
    expect(
      vjApplyAtFor(
        applyAtInput(state, withClip(state, CLIP_ID), {
          now: 4100,
          pendingApplyAt: 4500,
        }),
      ),
    ).toBe(4800);
  });

  it('lands an immediate change at once with every pending change', () => {
    const state = stageWithTempo();
    expect(
      vjApplyAtFor(
        applyAtInput(state, withClip(state, CLIP_ID), {
          now: 1300,
          isImmediate: true,
          pendingApplyAt: 1500,
        }),
      ),
    ).toBeNull();
  });

  it('computes no grid time for timer and library causes', () => {
    const live = withClip(stageWithTempo(), CLIP_ID);
    const cleared = withVjLiveSource(live, null);
    for (const cause of [
      'overlay_timeout',
      'countdown_end',
      'mic_tempo',
      'library',
    ] as const) {
      expect(
        vjApplyAtFor(applyAtInput(live, cleared, { cause, now: 1300 })),
      ).toBeNull();
      expect(
        vjApplyAtFor(
          applyAtInput(live, cleared, {
            cause,
            now: 1300,
            pendingApplyAt: 2000,
          }),
        ),
      ).toBe(2000);
    }
    expect(
      vjApplyAtFor(
        applyAtInput(live, withClip(live, SECOND_CLIP_ID), {
          cause: 'shuffle',
          now: 1300,
        }),
      ),
    ).toBe(1500);
  });

  it('a strobe timeout lands at once even with a quantized change pending', () => {
    const state = stageWithTempo({ bpm: 60, quantize: 'bar' });
    const strobing = {
      ...state,
      effects: { ...state.effects, isStrobing: true, strobeStartedAt: 0 },
    };
    const strobeOff = {
      ...strobing,
      effects: {
        ...strobing.effects,
        isStrobing: false,
        strobeStartedAt: null,
      },
    };
    expect(
      vjApplyAtFor(
        applyAtInput(strobing, strobeOff, {
          cause: 'strobe_timeout',
          now: 10000,
          pendingApplyAt: 12000,
        }),
      ),
    ).toBeNull();
    expect(
      vjApplyAtFor(
        applyAtInput(strobing, strobeOff, {
          cause: 'strobe_timeout',
          now: 10000,
        }),
      ),
    ).toBeNull();
  });
});

describe('stampVjChangeTimes', () => {
  it('stamps liveSince, the strobe start and hideAt from stampAt', () => {
    const idle = stageWithTempo();
    const live = stampVjChangeTimes(
      idle,
      withClip(idle, CLIP_ID),
      1500,
      undefined,
      KEEP_CLOCK,
    );
    expect(live.liveSince).toBe(1500);
    const kept = stampVjChangeTimes(
      live,
      withEffectsSpeed(live),
      1700,
      undefined,
      KEEP_CLOCK,
    );
    expect(kept.liveSince).toBe(1500);
    const retapped = stampVjChangeTimes(
      live,
      withClip(live, CLIP_ID),
      2000,
      undefined,
      KEEP_CLOCK,
    );
    expect(retapped.liveSince).toBe(2000);
    const switched = stampVjChangeTimes(
      live,
      withClip(live, SECOND_CLIP_ID),
      2500,
      undefined,
      KEEP_CLOCK,
    );
    expect(switched.liveSince).toBe(2500);
    const black = stampVjChangeTimes(
      live,
      withVjLiveSource(live, null),
      3000,
      undefined,
      KEEP_CLOCK,
    );
    expect(black.liveSince).toBeNull();

    const strobing: VjStageState = {
      ...idle,
      effects: { ...idle.effects, isStrobing: true },
    };
    const strobeOn = stampVjChangeTimes(
      idle,
      strobing,
      4000,
      undefined,
      KEEP_CLOCK,
    );
    expect(strobeOn.effects.strobeStartedAt).toBe(4000);
    const strobeHeld = stampVjChangeTimes(
      strobeOn,
      withEffectsSpeed(strobeOn),
      4500,
      undefined,
      KEEP_CLOCK,
    );
    expect(strobeHeld.effects.strobeStartedAt).toBe(4000);
    const strobeOff = stampVjChangeTimes(
      strobeOn,
      { ...strobeOn, effects: { ...strobeOn.effects, isStrobing: false } },
      5000,
      undefined,
      KEEP_CLOCK,
    );
    expect(strobeOff.effects.strobeStartedAt).toBeNull();

    const shown: VjStageState = {
      ...idle,
      overlay: {
        ...idle.overlay,
        text: 'hello',
        isVisible: true,
        hideAt: 9000,
      },
    };
    expect(
      stampVjChangeTimes(idle, shown, 6000, undefined, KEEP_CLOCK).overlay
        .hideAt,
    ).toBe(9000);
    expect(
      stampVjChangeTimes(idle, shown, 6000, null, KEEP_CLOCK).overlay.hideAt,
    ).toBeNull();
    expect(
      stampVjChangeTimes(idle, shown, 6000, 5000, KEEP_CLOCK).overlay.hideAt,
    ).toBe(11_000);
    const hidden: VjStageState = {
      ...shown,
      overlay: { ...shown.overlay, isVisible: false },
    };
    expect(
      stampVjChangeTimes(shown, hidden, 6000, 5000, KEEP_CLOCK).overlay.hideAt,
    ).toBeNull();
  });

  it('leaves the rest of the state alone', () => {
    const idle = stageWithTempo();
    const next = withClip(idle, CLIP_ID);
    const stamped = stampVjChangeTimes(idle, next, 1500, undefined, KEEP_CLOCK);
    expect(stamped).toEqual({ ...next, liveSince: 1500 });
  });
});

describe('vjAttachApplyAt', () => {
  it('carries the pending applyAt on attach while it is in the future', () => {
    expect(vjAttachApplyAt(5000, 4000)).toBe(5000);
    expect(vjAttachApplyAt(5000, 5000)).toBeNull();
    expect(vjAttachApplyAt(5000, 6000)).toBeNull();
    expect(vjAttachApplyAt(null, 4000)).toBeNull();
  });
});

/** A stage running a sequence step whose clock ends at `stepEndsAt`. */
function playingStage(
  stepEndsAt: number,
  tempo: Partial<VjTempo> = {},
): VjStageState {
  const state = stageWithTempo(tempo);
  return {
    ...state,
    activeSetlistId: SETLIST_ID,
    setlistIndex: 0,
    setlistPlayback: {
      ...state.setlistPlayback,
      status: 'playing',
      itemId: ITEM_ID,
      stepStartedAt: stepEndsAt - 8000,
      stepEndsAt,
      stepDurationMs: 8000,
    },
  };
}

describe('vjApplyAtFor for the sequence step timer', () => {
  it('counts setlist as a grid cause like a command', () => {
    const state = stageWithTempo();
    expect(
      vjApplyAtFor(
        applyAtInput(state, withEffectsSpeed(state), {
          cause: 'setlist',
          isLookSwitch: true,
          now: 1300,
        }),
      ),
    ).toBe(1500);
    expect(
      vjApplyAtFor(
        applyAtInput(state, withClip(state, CLIP_ID), {
          cause: 'setlist',
          now: 1300,
        }),
      ),
    ).toBe(1500);
    expect(
      vjApplyAtFor(
        applyAtInput(state, withEffectsSpeed(state), {
          cause: 'setlist',
          now: 1300,
        }),
      ),
    ).toBeNull();
  });

  it('lands at the step end with quantize off, and at once once it has passed', () => {
    const state = playingStage(2000, { quantize: 'off' });
    const advanced = withClip(state, CLIP_ID);
    expect(
      vjApplyAtFor(
        applyAtInput(state, advanced, {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2000,
          now: 1700,
        }),
      ),
    ).toBe(2000);
    expect(
      vjApplyAtFor(
        applyAtInput(state, advanced, {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2000,
          now: 2000,
        }),
      ),
    ).toBeNull();
    expect(
      vjApplyAtFor(
        applyAtInput(state, advanced, {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2000,
          now: 2600,
        }),
      ),
    ).toBeNull();
  });

  it('lands on the first boundary at or after the step end with quantize on', () => {
    const state = playingStage(2000);
    const advanced = withClip(state, CLIP_ID);
    const timerInput = (scheduledAt: number, now: number) =>
      applyAtInput(state, advanced, {
        cause: 'setlist',
        isLookSwitch: true,
        scheduledAt,
        now,
      });
    // Fired 300 ms early: a step end on a beat lands on that beat.
    expect(vjApplyAtFor(timerInput(2000, 1700))).toBe(2000);
    // A beat length rounded 1 ms short still lands on the beat (2 ms slack).
    expect(vjApplyAtFor(timerInput(1999, 1699))).toBe(2000);
    // A step end between beats lands on the next one.
    expect(vjApplyAtFor(timerInput(2100, 1800))).toBe(2500);
    // A late fire keeps the 150 ms lead from now.
    expect(vjApplyAtFor(timerInput(2000, 1900))).toBe(2500);
    const barState = playingStage(2400, { quantize: 'bar' });
    expect(
      vjApplyAtFor(
        applyAtInput(barState, withClip(barState, CLIP_ID), {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2400,
          now: 2100,
        }),
      ),
    ).toBe(4000);
  });

  it('places a timer landing that shows nothing at the step end too', () => {
    const state = playingStage(2000);
    const finished: VjStageState = {
      ...state,
      setlistPlayback: { ...state.setlistPlayback, status: 'finished' },
    };
    expect(
      vjApplyAtFor(
        applyAtInput(state, finished, {
          cause: 'setlist',
          scheduledAt: 2000,
          now: 1700,
        }),
      ),
    ).toBe(2000);
    const quantizeOff = playingStage(2000, { quantize: 'off' });
    expect(
      vjApplyAtFor(
        applyAtInput(quantizeOff, quantizeOff, {
          cause: 'setlist',
          scheduledAt: 2000,
          now: 1700,
        }),
      ),
    ).toBe(2000);
  });

  it('keeps the pending rule for a timer landing', () => {
    const state = playingStage(2000);
    const advanced = withClip(state, CLIP_ID);
    expect(
      vjApplyAtFor(
        applyAtInput(state, advanced, {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2000,
          now: 1700,
          pendingApplyAt: 3000,
        }),
      ),
    ).toBe(3000);
    expect(
      vjApplyAtFor(
        applyAtInput(state, advanced, {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2000,
          now: 1700,
          pendingApplyAt: 1800,
        }),
      ),
    ).toBe(2000);
    const quantizeOff = playingStage(2000, { quantize: 'off' });
    expect(
      vjApplyAtFor(
        applyAtInput(quantizeOff, withClip(quantizeOff, CLIP_ID), {
          cause: 'setlist',
          isLookSwitch: true,
          scheduledAt: 2000,
          now: 2100,
          pendingApplyAt: 2500,
        }),
      ),
    ).toBe(2500);
  });
});

describe('stampVjChangeTimes with a sequence clock', () => {
  it('starts a step clock from stampAt', () => {
    const idle = stageWithTempo();
    const stamped = stampVjChangeTimes(idle, playingStage(0), 2000, undefined, {
      kind: 'start',
      durationMs: 8000,
      remainingMs: 8000,
    });
    expect(stamped.setlistPlayback).toMatchObject({
      status: 'playing',
      stepStartedAt: 2000,
      stepEndsAt: 10_000,
      stepDurationMs: 8000,
      pausedRemainingMs: null,
    });
  });

  it('resumes a paused clock with its time left and full length', () => {
    const playing = playingStage(0);
    const paused: VjStageState = {
      ...playing,
      setlistPlayback: {
        ...playing.setlistPlayback,
        status: 'paused',
        stepStartedAt: null,
        stepEndsAt: null,
        pausedRemainingMs: 3000,
      },
    };
    const resumed: VjStageState = {
      ...paused,
      setlistPlayback: { ...paused.setlistPlayback, status: 'playing' },
    };
    const stamped = stampVjChangeTimes(paused, resumed, 5000, undefined, {
      kind: 'start',
      durationMs: 8000,
      remainingMs: 3000,
    });
    expect(stamped.setlistPlayback).toMatchObject({
      stepStartedAt: 0,
      stepEndsAt: 8000,
      stepDurationMs: 8000,
      pausedRemainingMs: null,
    });
  });

  it('clears the clock times and keeps the full length', () => {
    const playing = playingStage(10_000);
    const finished: VjStageState = {
      ...playing,
      setlistPlayback: { ...playing.setlistPlayback, status: 'finished' },
    };
    const stamped = stampVjChangeTimes(playing, finished, 10_000, undefined, {
      kind: 'clear',
    });
    expect(stamped.setlistPlayback).toEqual({
      ...finished.setlistPlayback,
      stepStartedAt: null,
      stepEndsAt: null,
      stepDurationMs: 8000,
    });
  });

  it('keeps the playback as given', () => {
    const playing = playingStage(10_000);
    const stamped = stampVjChangeTimes(
      playing,
      playing,
      4000,
      undefined,
      KEEP_CLOCK,
    );
    expect(stamped.setlistPlayback).toBe(playing.setlistPlayback);
  });
});
