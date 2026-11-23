import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { ConversationParticipant } from './entities/conversation-participant.entity';

/**
 * SEC-25: a member who leaves a group (or is removed) and later takes the
 * seat back reads the history up to the moment they left, minus anything
 * they cleared, and nothing posted while they were away. The away stretch is
 * stored on the seat as `absenceStartedAt` (the old `leftAt`) and
 * `absenceEndedAt` (the re-seat instant). A message created after the first
 * and at or before the second does not exist for that member on any surface.
 */
export type AbsenceGapSeat = Pick<
  ConversationParticipant,
  'absenceStartedAt' | 'absenceEndedAt'
>;

/**
 * SQL that holds when a row created at `createdAtExpression` sits inside the
 * absence gap of the seat `seatAlias` (`conversation_participants`, read
 * through its raw `absence_started_at` / `absence_ended_at` columns).
 * Compose it as `NOT ...` to keep only what the seat may see.
 */
export function insideAbsenceGapPredicate(
  createdAtExpression: string,
  seatAlias: string,
): string {
  return `(${seatAlias}.absence_started_at IS NOT NULL
    AND ${seatAlias}.absence_ended_at IS NOT NULL
    AND ${createdAtExpression} > ${seatAlias}.absence_started_at
    AND ${createdAtExpression} <= ${seatAlias}.absence_ended_at)`;
}

/** The in-memory twin of {@link insideAbsenceGapPredicate}. */
export function isInsideAbsenceGap(
  createdAt: Date,
  seat: Partial<AbsenceGapSeat> | null | undefined,
): boolean {
  if (!seat?.absenceStartedAt || !seat.absenceEndedAt) {
    return false;
  }
  const createdAtTime = createdAt.getTime();
  return (
    createdAtTime > seat.absenceStartedAt.getTime() &&
    createdAtTime <= seat.absenceEndedAt.getTime()
  );
}

/** Whether the seat carries an absence gap at all. */
export function hasAbsenceGap(
  seat: Partial<AbsenceGapSeat> | null | undefined,
): boolean {
  return Boolean(seat?.absenceStartedAt && seat.absenceEndedAt);
}

/**
 * Adds "outside this loaded seat's absence gap" to a builder whose message
 * creation column is `createdAtColumn`, with bound parameters. A seat with
 * no gap adds nothing.
 */
export function andOutsideAbsenceGap<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  createdAtColumn: string,
  seat: Partial<AbsenceGapSeat> | null | undefined,
): SelectQueryBuilder<Entity> {
  if (!seat?.absenceStartedAt || !seat.absenceEndedAt) {
    return queryBuilder;
  }
  return queryBuilder.andWhere(
    `NOT (${createdAtColumn} > :absenceStartedAt AND ${createdAtColumn} <= :absenceEndedAt)`,
    {
      absenceStartedAt: seat.absenceStartedAt.toISOString(),
      absenceEndedAt: seat.absenceEndedAt.toISOString(),
    },
  );
}

/**
 * The history fields a group seat takes when it is re-seated at
 * `reseatedAt` (the transaction's join floor, `readGroupJoinHistoryFloor`).
 *
 * - `clearedAt` keeps the member's own clear point, so the history they
 *   could read before leaving stays readable.
 * - The gap runs from the old `leftAt` to `reseatedAt`, so nothing posted
 *   while they were away reaches them.
 * - Known limit: a seat holds ONE gap. When it already has one (a second
 *   leave and re-seat), `clearedAt` rises to the end of the earlier gap.
 *   That keeps both absences hidden and the stretch between them readable,
 *   and it drops everything from before the first absence from the
 *   member's view for good. It errs private.
 * - A seat with no `leftAt` (never away) keeps its fields as they are.
 */
export function reseatHistoryWindow(
  existing: Pick<
    ConversationParticipant,
    'clearedAt' | 'leftAt' | 'absenceStartedAt' | 'absenceEndedAt'
  >,
  reseatedAt: Date,
): Pick<
  ConversationParticipant,
  'clearedAt' | 'absenceStartedAt' | 'absenceEndedAt'
> {
  if (!existing.leftAt) {
    return {
      clearedAt: existing.clearedAt,
      absenceStartedAt: existing.absenceStartedAt,
      absenceEndedAt: existing.absenceEndedAt,
    };
  }
  const clearedAt = laterOf(existing.clearedAt, existing.absenceEndedAt);
  const absenceStartedAt = laterOf(existing.leftAt, clearedAt);
  const hasGap =
    absenceStartedAt !== null &&
    absenceStartedAt.getTime() < reseatedAt.getTime();
  return {
    clearedAt,
    absenceStartedAt: hasGap ? absenceStartedAt : null,
    absenceEndedAt: hasGap ? reseatedAt : null,
  };
}

function laterOf(
  first: Date | null | undefined,
  second: Date | null | undefined,
): Date | null {
  if (!first) return second ?? null;
  if (!second) return first;
  return second.getTime() > first.getTime() ? second : first;
}
