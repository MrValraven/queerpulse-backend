import {
  createVjStageState,
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
    );
    expect(live.liveSince).toBe(1500);
    const kept = stampVjChangeTimes(
      live,
      withEffectsSpeed(live),
      1700,
      undefined,
    );
    expect(kept.liveSince).toBe(1500);
    const retapped = stampVjChangeTimes(
      live,
      withClip(live, CLIP_ID),
      2000,
      undefined,
    );
    expect(retapped.liveSince).toBe(2000);
    const switched = stampVjChangeTimes(
      live,
      withClip(live, SECOND_CLIP_ID),
      2500,
      undefined,
    );
    expect(switched.liveSince).toBe(2500);
    const black = stampVjChangeTimes(
      live,
      withVjLiveSource(live, null),
      3000,
      undefined,
    );
    expect(black.liveSince).toBeNull();

    const strobing: VjStageState = {
      ...idle,
      effects: { ...idle.effects, isStrobing: true },
    };
    const strobeOn = stampVjChangeTimes(idle, strobing, 4000, undefined);
    expect(strobeOn.effects.strobeStartedAt).toBe(4000);
    const strobeHeld = stampVjChangeTimes(
      strobeOn,
      withEffectsSpeed(strobeOn),
      4500,
      undefined,
    );
    expect(strobeHeld.effects.strobeStartedAt).toBe(4000);
    const strobeOff = stampVjChangeTimes(
      strobeOn,
      { ...strobeOn, effects: { ...strobeOn.effects, isStrobing: false } },
      5000,
      undefined,
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
      stampVjChangeTimes(idle, shown, 6000, undefined).overlay.hideAt,
    ).toBe(9000);
    expect(
      stampVjChangeTimes(idle, shown, 6000, null).overlay.hideAt,
    ).toBeNull();
    expect(stampVjChangeTimes(idle, shown, 6000, 5000).overlay.hideAt).toBe(
      11_000,
    );
    const hidden: VjStageState = {
      ...shown,
      overlay: { ...shown.overlay, isVisible: false },
    };
    expect(
      stampVjChangeTimes(shown, hidden, 6000, 5000).overlay.hideAt,
    ).toBeNull();
  });

  it('leaves the rest of the state alone', () => {
    const idle = stageWithTempo();
    const next = withClip(idle, CLIP_ID);
    const stamped = stampVjChangeTimes(idle, next, 1500, undefined);
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
