import {
  VJ_LIMITS,
  vjSetlistTimerTargetAt,
  type VjStageCause,
  type VjStageState,
} from '../vj.contract';

/** The clocks a stage keeps (contract 7.14), and the sequence step timer
 *  (sequences 5.7). */
export type VjTimerKind = 'strobe' | 'overlay' | 'countdown' | 'setlist';

/** Every timer kind, in the order `sync` walks them; the step timer last. */
const VJ_TIMER_KINDS: readonly VjTimerKind[] = [
  'strobe',
  'overlay',
  'countdown',
  'setlist',
];

/** Longest delay `setTimeout` honours; a longer wait re-arms on fire. */
const TIMEOUT_DELAY_MAX_MS = 2_147_483_647;

/** The `stage:state` cause each timer's fire carries. */
export const VJ_TIMER_CAUSES: Readonly<Record<VjTimerKind, VjStageCause>> =
  Object.freeze({
    strobe: 'strobe_timeout',
    overlay: 'overlay_timeout',
    countdown: 'countdown_end',
    setlist: 'setlist',
  });

/** The fire time each timer wants for a state, or null when it should be off:
 *  the strobe 10 s after its stamp while strobing, the overlay at `hideAt`
 *  while visible, the countdown 10 s after zero while visible, and the step
 *  timer `quantizedAdvanceEarlyMs` before `stepEndsAt` while playing. */
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
    setlist: vjSetlistTimerTargetAt(state),
  };
}

/** The state a fired timer leaves (contract 7.14), or null when its field
 *  already changed: the strobe off with no stamp, the overlay hidden with no
 *  `hideAt`, the countdown hidden with its target and label kept. The step
 *  timer always answers null here: its fire needs a set list read, so the
 *  stage service lands it through its own async path (sequences 5.7). */
export function vjTimerFireState(
  kind: VjTimerKind,
  state: VjStageState,
): VjStageState | null {
  if (kind === 'setlist') {
    return null;
  }
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

/** One armed timer: when it fires, and the state target it serves. A plain
 *  timer fires at the target it serves; a retry fires later for the target
 *  that already fired. */
interface VjArmedTimer {
  fireAt: number;
  servedTarget: number;
  handle: NodeJS.Timeout;
}

/** A stage's strobe, overlay, countdown and step timers, armed for absolute
 *  targets read from the state. The owner applies the fire state. */
export class VjStageTimers {
  private readonly armed = new Map<VjTimerKind, VjArmedTimer>();

  /** The state target each kind last fired for. `sync` never arms a kind
   *  again for that same target: the step timer's state stays as it was
   *  until its async read lands, and a second fire would read twice. */
  private readonly firedTargets = new Map<VjTimerKind, number>();

  constructor(private readonly onFire: (kind: VjTimerKind) => void) {}

  /** Arms, re-arms or clears each timer from the state's targets. A timer
   *  serving the state's target is kept (a pending retry included); a target
   *  the kind already fired for arms nothing; an off target forgets the
   *  fired one. Delay is fire time minus Date.now(), at least 0; timers
   *  unref. */
  sync(state: VjStageState): void {
    const targets = vjTimerTargets(state);
    for (const kind of VJ_TIMER_KINDS) {
      const target = targets[kind];
      if (this.armed.get(kind)?.servedTarget === target) {
        continue;
      }
      this.clearKind(kind);
      if (target === null) {
        this.firedTargets.delete(kind);
        continue;
      }
      if (this.firedTargets.get(kind) === target) {
        continue;
      }
      this.arm(kind, target, target);
    }
  }

  /** Arms a kind to fire again at `target` (Date.now() based) for the state
   *  target it last fired for, whatever the fired memory says: the step
   *  timer calls it after a failed read, so the show holds its step and
   *  tries again. A kind already armed (a newer state target, or an earlier
   *  retry) keeps that timer. Logs nothing. */
  retry(kind: VjTimerKind, target: number): void {
    if (this.armed.has(kind)) {
      return;
    }
    this.arm(kind, target, this.firedTargets.get(kind) ?? target);
  }

  /** Clears every timer and the fired memory (stage eviction and module
   *  shutdown). */
  clear(): void {
    for (const kind of VJ_TIMER_KINDS) {
      this.clearKind(kind);
    }
    this.firedTargets.clear();
  }

  private arm(kind: VjTimerKind, fireAt: number, servedTarget: number): void {
    const delay = Math.min(
      Math.max(0, fireAt - Date.now()),
      TIMEOUT_DELAY_MAX_MS,
    );
    const handle = setTimeout(() => {
      this.handleFire(kind, handle);
    }, delay);
    handle.unref();
    this.armed.set(kind, { fireAt, servedTarget, handle });
  }

  /** A handle the map no longer holds does nothing; a fire before its time
   *  (a delay past the `setTimeout` maximum) re-arms for the rest. A fire
   *  remembers the target it served, then calls the owner. */
  private handleFire(kind: VjTimerKind, handle: NodeJS.Timeout): void {
    const current = this.armed.get(kind);
    if (current === undefined || current.handle !== handle) {
      return;
    }
    this.armed.delete(kind);
    if (Date.now() < current.fireAt) {
      this.arm(kind, current.fireAt, current.servedTarget);
      return;
    }
    this.firedTargets.set(kind, current.servedTarget);
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
