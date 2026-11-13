import {
  stampVjSetlistClock,
  vjIsQuantizedChange,
  vjQuantizedApplyAt,
  vjSetlistAdvanceApplyAt,
  type VjSetlistClockStamp,
  type VjStageCause,
  type VjStageState,
} from '../vj.contract';

/** The causes whose change may land on the tempo grid: commands, shuffle
 *  and the server step timer (`setlist`). Timer causes (`overlay_timeout`,
 *  `countdown_end`, `mic_tempo`) and `library` never compute a grid time;
 *  they only inherit a pending one (contract 7.4). */
const VJ_GRID_CAUSES: readonly VjStageCause[] = [
  'command',
  'shuffle',
  'setlist',
];

/** The causes that always land at once with every pending change: the 10 s
 *  strobe cap is absolute, so strobe-off never waits for a pending bar
 *  (contract 7.4). */
const VJ_IMMEDIATE_CAUSES: readonly VjStageCause[] = ['strobe_timeout'];

/** What contract 7.4 steps 2 and 3 read to place one applied change. */
export interface VjApplyAtInput {
  previous: VjStageState;
  next: VjStageState;
  /** Recall and set list steps land on the grid even when the source stays. */
  isLookSwitch: boolean;
  isImmediate: boolean;
  /** Why the change happens: only `command`, `shuffle` and `setlist`
   *  compute a grid time. */
  cause: VjStageCause;
  /** The step end a timer advance lands at (sequences 5.7); null for every
   *  other change. A number places the change with `vjSetlistAdvanceApplyAt`
   *  whatever `isLookSwitch` says. */
  scheduledAt: number | null;
  /** The stage's last stamped applyAt (memory only). */
  pendingApplyAt: number | null;
  now: number;
}

/** The time this change computes before the pending rule: a timer advance
 *  lands at its step end (quantize off) or the first boundary at or after it
 *  (quantize on); any other grid change lands on the next boundary when it
 *  switches the look or moves a quantized field; the rest compute nothing. */
function computedVjApplyAt(input: VjApplyAtInput): number | null {
  if (input.scheduledAt !== null) {
    return vjSetlistAdvanceApplyAt(
      input.next.tempo,
      input.scheduledAt,
      input.now,
    );
  }
  const isOnGrid =
    VJ_GRID_CAUSES.includes(input.cause) &&
    (input.isLookSwitch || vjIsQuantizedChange(input.previous, input.next));
  return isOnGrid ? vjQuantizedApplyAt(input.next.tempo, input.now) : null;
}

/** Contract 7.4 steps 2 and 3: the server time every client applies this
 *  change at, or null to apply at once. A change never lands before a
 *  pending one, and an immediate change or a strobe timeout lands at once
 *  with every pending change (the state is cumulative). */
export function vjApplyAtFor(input: VjApplyAtInput): number | null {
  if (input.isImmediate || VJ_IMMEDIATE_CAUSES.includes(input.cause)) {
    return null;
  }
  const computed = computedVjApplyAt(input);
  const pending =
    input.pendingApplyAt !== null && input.pendingApplyAt > input.now
      ? input.pendingApplyAt
      : null;
  return pending === null ? computed : Math.max(pending, computed ?? pending);
}

/** Whether something is live: a clip or a generator. */
function isVjSourceLive(state: VjStageState): boolean {
  return state.liveClipId !== null || state.liveGeneratorId !== null;
}

/** liveSince (plan note 12): stampAt when the live source changed or
 *  clipSequence grew while a source is live, null when nothing is live,
 *  else kept. */
function stampedLiveSince(
  previous: VjStageState,
  next: VjStageState,
  stampAt: number,
): number | null {
  if (!isVjSourceLive(next)) {
    return null;
  }
  const isSourceChanged =
    previous.liveClipId !== next.liveClipId ||
    previous.liveGeneratorId !== next.liveGeneratorId ||
    previous.liveGeneratorVariant !== next.liveGeneratorVariant ||
    next.clipSequence > previous.clipSequence;
  return isSourceChanged ? stampAt : (next.liveSince ?? stampAt);
}

/** strobeStartedAt: stampAt when the strobe goes on, kept while it stays on,
 *  null while off. */
function stampedStrobeStartedAt(
  previous: VjStageState,
  next: VjStageState,
  stampAt: number,
): number | null {
  if (!next.effects.isStrobing) {
    return null;
  }
  if (!previous.effects.isStrobing) {
    return stampAt;
  }
  return next.effects.strobeStartedAt ?? stampAt;
}

/** overlay.hideAt: null while hidden; otherwise undefined keeps it, null
 *  clears it and a number stamps stampAt + value. */
function stampedOverlayHideAt(
  next: VjStageState,
  stampAt: number,
  overlayHideAfterMs: number | null | undefined,
): number | null {
  if (!next.overlay.isVisible) {
    return null;
  }
  if (overlayHideAfterMs === undefined) {
    return next.overlay.hideAt;
  }
  return overlayHideAfterMs === null ? null : stampAt + overlayHideAfterMs;
}

/** Contract 7.4 step 5 with plan note 12: `liveSince`, `strobeStartedAt`,
 *  `overlay.hideAt` and the sequence clock (`setlistClock`, sequences 3.5)
 *  stamped from `stampAt` (the change's applyAt, or now). */
export function stampVjChangeTimes(
  previous: VjStageState,
  next: VjStageState,
  stampAt: number,
  overlayHideAfterMs: number | null | undefined,
  setlistClock: VjSetlistClockStamp,
): VjStageState {
  return {
    ...next,
    setlistPlayback: stampVjSetlistClock(
      next.setlistPlayback,
      setlistClock,
      stampAt,
    ),
    liveSince: stampedLiveSince(previous, next, stampAt),
    effects: {
      ...next.effects,
      strobeStartedAt: stampedStrobeStartedAt(previous, next, stampAt),
    },
    overlay: {
      ...next.overlay,
      hideAt: stampedOverlayHideAt(next, stampAt, overlayHideAfterMs),
    },
  };
}

/** The applyAt an attach frame carries (contract 7.4): the pending applyAt
 *  while it is in the future, else null. */
export function vjAttachApplyAt(
  pendingApplyAt: number | null,
  now: number,
): number | null {
  return pendingApplyAt !== null && pendingApplyAt > now
    ? pendingApplyAt
    : null;
}
