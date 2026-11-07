import { createVjStageState, type VjStageState } from '../vj.contract';
import {
  VJ_TIMER_CAUSES,
  VjStageTimers,
  vjTimerFireState,
  vjTimerTargets,
  type VjTimerKind,
} from './vj-stage-timers';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const START = 1_800_000_000_000;

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
    });
  });
});
