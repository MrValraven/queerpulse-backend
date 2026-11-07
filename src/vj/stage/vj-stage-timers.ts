import {
  VJ_LIMITS,
  type VjStageCause,
  type VjStageState,
} from '../vj.contract';

/** The three clocks a stage keeps (contract 7.14). */
export type VjTimerKind = 'strobe' | 'overlay' | 'countdown';

/** Every timer kind, in the order `sync` walks them. */
const VJ_TIMER_KINDS: readonly VjTimerKind[] = [
  'strobe',
  'overlay',
  'countdown',
];

/** Longest delay `setTimeout` honours; a longer wait re-arms on fire. */
const TIMEOUT_DELAY_MAX_MS = 2_147_483_647;

/** The `stage:state` cause each timer's fire carries. */
export const VJ_TIMER_CAUSES: Readonly<Record<VjTimerKind, VjStageCause>> =
  Object.freeze({
    strobe: 'strobe_timeout',
    overlay: 'overlay_timeout',
    countdown: 'countdown_end',
  });

/** The fire time each timer wants for a state, or null when it should be off:
 *  the strobe 10 s after its stamp while strobing, the overlay at `hideAt`
 *  while visible, the countdown 10 s after zero while visible. */
export function vjTimerTargets(
  state: VjStageState,
): Record<VjTimerKind, number | null> {
  const { effects, overlay, countdown } = state;
  return {
    strobe:
      effects.isStrobing && effects.strobeStartedAt !== null
        ? effects.strobeStartedAt + VJ_LIMITS.strobeMaxDurationMs
        : null,
    overlay:
      overlay.isVisible && overlay.hideAt !== null ? overlay.hideAt : null,
    countdown:
      countdown.isVisible && countdown.targetAt !== null
        ? countdown.targetAt + VJ_LIMITS.countdownHoldMs
        : null,
  };
}

/** The state a fired timer leaves (contract 7.14), or null when its field
 *  already changed: the strobe off with no stamp, the overlay hidden with no
 *  `hideAt`, the countdown hidden with its target and label kept. */
export function vjTimerFireState(
  kind: VjTimerKind,
  state: VjStageState,
): VjStageState | null {
  if (kind === 'strobe') {
    if (!state.effects.isStrobing) {
      return null;
    }
    return {
      ...state,
      effects: { ...state.effects, isStrobing: false, strobeStartedAt: null },
    };
  }
  if (kind === 'overlay') {
    if (!state.overlay.isVisible || state.overlay.hideAt === null) {
      return null;
    }
    return {
      ...state,
      overlay: { ...state.overlay, isVisible: false, hideAt: null },
    };
  }
  if (!state.countdown.isVisible) {
    return null;
  }
  return { ...state, countdown: { ...state.countdown, isVisible: false } };
}

/** One armed timer and the absolute time it was armed for. */
interface VjArmedTimer {
  target: number;
  handle: NodeJS.Timeout;
}

/** A stage's strobe, overlay and countdown timers, armed for absolute
 *  targets read from the state. The owner applies the fire state. */
export class VjStageTimers {
  private readonly armed = new Map<VjTimerKind, VjArmedTimer>();

  constructor(private readonly onFire: (kind: VjTimerKind) => void) {}

  /** Arms, re-arms or clears each timer from the state's targets; a target
   *  that did not change keeps its timer. Delay is target minus Date.now(),
   *  at least 0; timers unref. */
  sync(state: VjStageState): void {
    const targets = vjTimerTargets(state);
    for (const kind of VJ_TIMER_KINDS) {
      const target = targets[kind];
      if (this.armed.get(kind)?.target === target) {
        continue;
      }
      this.clearKind(kind);
      if (target !== null) {
        this.arm(kind, target);
      }
    }
  }

  /** Clears every timer (stage eviction and module shutdown). */
  clear(): void {
    for (const kind of VJ_TIMER_KINDS) {
      this.clearKind(kind);
    }
  }

  private arm(kind: VjTimerKind, target: number): void {
    const delay = Math.min(
      Math.max(0, target - Date.now()),
      TIMEOUT_DELAY_MAX_MS,
    );
    const handle = setTimeout(() => {
      this.handleFire(kind, handle);
    }, delay);
    handle.unref();
    this.armed.set(kind, { target, handle });
  }

  /** A handle the map no longer holds does nothing; a fire before its target
   *  (a delay past the `setTimeout` maximum) re-arms for the rest. */
  private handleFire(kind: VjTimerKind, handle: NodeJS.Timeout): void {
    const current = this.armed.get(kind);
    if (current === undefined || current.handle !== handle) {
      return;
    }
    this.armed.delete(kind);
    if (Date.now() < current.target) {
      this.arm(kind, current.target);
      return;
    }
    this.onFire(kind);
  }

  private clearKind(kind: VjTimerKind): void {
    const current = this.armed.get(kind);
    if (current !== undefined) {
      clearTimeout(current.handle);
      this.armed.delete(kind);
    }
  }
}
