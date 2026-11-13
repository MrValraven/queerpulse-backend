import {
  VJ_LIMITS,
  createVjStageState,
  type VjStageState,
} from '../vj.contract';
import {
  VJ_TIMER_CAUSES,
  VjStageTimers,
  vjTimerFireState,
  vjTimerTargets,
  type VjTimerKind,
} from './vj-stage-timers';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const START = 1_800_000_000_000;
const SETLIST_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_ID = '55555555-5555-4555-8555-555555555555';

function baseState(): VjStageState {
  return createVjStageState(STAGE_EPOCH, START);
}

function strobingState(strobeStartedAt: number): VjStageState {
  const state = baseState();
  return {
    ...state,
    effects: { ...state.effects, isStrobing: true, strobeStartedAt },
  };
}

function overlayState(hideAt: number | null): VjStageState {
  const state = baseState();
  return {
    ...state,
    overlay: { ...state.overlay, text: 'Hello', isVisible: true, hideAt },
  };
}

function countdownState(targetAt: number): VjStageState {
  const state = baseState();
  return {
    ...state,
    countdown: { isVisible: true, targetAt, label: 'Doors' },
  };
}

function playingState(stepEndsAt: number): VjStageState {
  const state = baseState();
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

function pausedState(): VjStageState {
  const state = playingState(START + 8000);
  return {
    ...state,
    setlistPlayback: {
      ...state.setlistPlayback,
      status: 'paused',
      stepStartedAt: null,
      stepEndsAt: null,
      pausedRemainingMs: 4000,
    },
  };
}

describe('vj stage timers', () => {
  let fired: VjTimerKind[];
  let timers: VjStageTimers;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    fired = [];
    timers = new VjStageTimers((kind) => {
      fired.push(kind);
    });
  });

  afterEach(() => {
    timers.clear();
    jest.useRealTimers();
  });

  it('names the cause of each timer', () => {
    expect(VJ_TIMER_CAUSES).toEqual({
      strobe: 'strobe_timeout',
      overlay: 'overlay_timeout',
      countdown: 'countdown_end',
      setlist: 'setlist',
    });
  });

  it('fires the strobe ten seconds after its stamp', () => {
    const state = strobingState(START + 500);
    expect(vjTimerTargets(state).strobe).toBe(START + 10_500);
    timers.sync(state);
    jest.advanceTimersByTime(10_499);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['strobe']);
    expect(vjTimerFireState('strobe', state)?.effects).toMatchObject({
      isStrobing: false,
      strobeStartedAt: null,
    });
  });

  it('fires the overlay at hideAt and the countdown ten seconds after zero', () => {
    const state: VjStageState = {
      ...overlayState(START + 5000),
      countdown: { isVisible: true, targetAt: START + 8000, label: 'Doors' },
    };
    expect(vjTimerTargets(state)).toEqual({
      strobe: null,
      overlay: START + 5000,
      countdown: START + 18_000,
      setlist: null,
    });
    timers.sync(state);
    jest.advanceTimersByTime(4999);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['overlay']);
    jest.advanceTimersByTime(12_999);
    expect(fired).toEqual(['overlay']);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['overlay', 'countdown']);

    expect(vjTimerFireState('overlay', state)?.overlay).toMatchObject({
      isVisible: false,
      hideAt: null,
      text: 'Hello',
    });
    expect(vjTimerFireState('countdown', state)?.countdown).toEqual({
      isVisible: false,
      targetAt: START + 8000,
      label: 'Doors',
    });
  });

  it('fires at once for a target already past', () => {
    timers.sync(overlayState(START - 1000));
    jest.advanceTimersByTime(0);
    expect(fired).toEqual(['overlay']);
  });

  it('re-arms when the target moves and keeps the timer when it does not', () => {
    timers.sync(overlayState(START + 5000));
    jest.advanceTimersByTime(3000);
    timers.sync(overlayState(START + 5000));
    jest.advanceTimersByTime(2000);
    expect(fired).toEqual(['overlay']);

    timers.sync(countdownState(START + 10_000));
    jest.advanceTimersByTime(1000);
    timers.sync(countdownState(START + 20_000));
    jest.advanceTimersByTime(14_000);
    expect(fired).toEqual(['overlay']);
    jest.advanceTimersByTime(10_000);
    expect(fired).toEqual(['overlay', 'countdown']);

    timers.sync(strobingState(Date.now()));
    jest.advanceTimersByTime(4000);
    timers.sync(baseState());
    jest.advanceTimersByTime(20_000);
    expect(fired).toEqual(['overlay', 'countdown']);
  });

  it('clears every timer', () => {
    timers.sync({
      ...strobingState(START),
      overlay: overlayState(START + 3000).overlay,
      countdown: countdownState(START + 2000).countdown,
    });
    timers.clear();
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('answers null for a fire whose field already changed', () => {
    const state = baseState();
    expect(vjTimerFireState('strobe', state)).toBeNull();
    expect(vjTimerFireState('overlay', state)).toBeNull();
    expect(vjTimerFireState('overlay', overlayState(null))).toBeNull();
    expect(vjTimerFireState('countdown', state)).toBeNull();
    expect(vjTimerTargets(overlayState(null)).overlay).toBeNull();
    expect(vjTimerTargets(state)).toEqual({
      strobe: null,
      overlay: null,
      countdown: null,
      setlist: null,
    });
  });

  it('fires the step timer quantizedAdvanceEarlyMs before the step ends', () => {
    const state = playingState(START + 8000);
    expect(VJ_LIMITS.quantizedAdvanceEarlyMs).toBe(300);
    expect(vjTimerTargets(state).setlist).toBe(START + 7700);
    timers.sync(state);
    jest.advanceTimersByTime(7699);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['setlist']);
    expect(vjTimerFireState('setlist', state)).toBeNull();
  });

  it('wants no step timer unless the sequence is playing', () => {
    expect(vjTimerTargets(pausedState()).setlist).toBeNull();
    const finished = playingState(START + 8000);
    expect(
      vjTimerTargets({
        ...finished,
        setlistPlayback: {
          ...finished.setlistPlayback,
          status: 'finished',
          stepStartedAt: null,
          stepEndsAt: null,
        },
      }).setlist,
    ).toBeNull();
    timers.sync(pausedState());
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fires at once for a restored step whose end already passed', () => {
    timers.sync(playingState(START - 5000));
    jest.advanceTimersByTime(0);
    expect(fired).toEqual(['setlist']);
  });

  it('never arms a target again once it fired, while the read is out', () => {
    const state = playingState(START + 8000);
    timers.sync(state);
    jest.advanceTimersByTime(7700);
    expect(fired).toEqual(['setlist']);

    timers.sync(state);
    timers.sync({ ...state, revision: state.revision + 1 });
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual(['setlist']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('arms the next step target the landed state brings', () => {
    timers.sync(playingState(START + 8000));
    jest.advanceTimersByTime(7700);
    expect(fired).toEqual(['setlist']);

    timers.sync(playingState(START + 16_000));
    jest.advanceTimersByTime(7999);
    expect(fired).toEqual(['setlist']);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['setlist', 'setlist']);
  });

  it('forgets the fired target when the timer turns off', () => {
    const state = playingState(START + 8000);
    timers.sync(state);
    jest.advanceTimersByTime(7700);
    timers.sync(pausedState());
    timers.sync(state);
    jest.advanceTimersByTime(0);
    expect(fired).toEqual(['setlist', 'setlist']);
  });

  it('retries after a failed read and the next sync keeps that retry', () => {
    const state = playingState(START + 8000);
    timers.sync(state);
    jest.advanceTimersByTime(7700);
    expect(fired).toEqual(['setlist']);

    timers.retry('setlist', Date.now() + VJ_LIMITS.setlistTimerRetryMs);
    timers.sync(state);
    timers.sync({ ...state, revision: state.revision + 1 });
    jest.advanceTimersByTime(999);
    expect(fired).toEqual(['setlist']);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['setlist', 'setlist']);

    timers.sync(state);
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual(['setlist', 'setlist']);
  });

  it('drops a retry once the state moves to another target', () => {
    const state = playingState(START + 8000);
    timers.sync(state);
    jest.advanceTimersByTime(7700);
    timers.retry('setlist', Date.now() + 1000);
    timers.sync(pausedState());
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual(['setlist']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps a newer armed target over a retry asked for the old one', () => {
    timers.sync(playingState(START + 8000));
    jest.advanceTimersByTime(7700);
    timers.sync(playingState(START + 20_000));
    timers.retry('setlist', Date.now() + 1000);
    jest.advanceTimersByTime(1000);
    expect(fired).toEqual(['setlist']);
    jest.advanceTimersByTime(11_000);
    expect(fired).toEqual(['setlist', 'setlist']);
  });

  it('arms a retry for a kind that never fired', () => {
    timers.retry('setlist', START + 2000);
    jest.advanceTimersByTime(1999);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(['setlist']);
  });

  it('clears the step timer and its retry with the stage', () => {
    timers.sync(playingState(START + 8000));
    timers.clear();
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);

    timers.sync(playingState(START + 70_000));
    jest.advanceTimersByTime(10_000);
    expect(fired).toEqual(['setlist']);
    timers.retry('setlist', Date.now() + 1000);
    timers.clear();
    jest.advanceTimersByTime(60_000);
    expect(fired).toEqual(['setlist']);
    expect(jest.getTimerCount()).toBe(0);
  });
});
