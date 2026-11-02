/**
 * The schedule rules every new or edited gathering passes, kept pure so two
 * callers can share them. `EventsService.assertScheduleValid` turns a problem
 * into the 400 `create` and `update` have always sent, and the batch
 * (`EventBatchService.createBatch`) turns it into a coded error that names the
 * row and the field the host has to fix.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The longest a single gathering may run, start to end. A festival or a
 *  multi-night retreat fits comfortably; a typo that would pin a gathering to
 *  the top of browse for two years does not. Mirrored client-side by
 *  `MAX_GATHERING_SPAN_DAYS` in the wizard's `createGathering.data.ts`. */
export const MAX_GATHERING_SPAN_DAYS = 14;

/** Which rule a schedule breaks: a start already gone, an end on or before
 *  the start, or a gathering longer than `MAX_GATHERING_SPAN_DAYS`. */
export type EventScheduleProblem =
  'startInPast' | 'endNotAfterStart' | 'spanTooLong';

/**
 * Names the first rule `startAt` and `endAt` break, or `null` when the
 * schedule is fine. The checks run in the order `create` has always applied
 * them (past start, then end after start, then the span), so a schedule that
 * breaks two rules reports the same one it always did. `rejectPast` is off for
 * an edit, which may keep a start that has since passed; `now` lets a caller
 * check a whole batch against one instant, and defaults to the current time.
 * An open end (`null`) passes both end rules.
 */
export function eventScheduleProblem(
  startAt: Date,
  endAt: Date | null,
  options: { rejectPast: boolean; now?: Date },
): EventScheduleProblem | null {
  const nowMilliseconds = options.now?.getTime() ?? Date.now();
  if (options.rejectPast && startAt.getTime() < nowMilliseconds) {
    return 'startInPast';
  }
  if (endAt && endAt.getTime() <= startAt.getTime()) {
    return 'endNotAfterStart';
  }
  if (
    endAt &&
    endAt.getTime() - startAt.getTime() >
      MAX_GATHERING_SPAN_DAYS * MILLISECONDS_PER_DAY
  ) {
    return 'spanTooLong';
  }
  return null;
}
