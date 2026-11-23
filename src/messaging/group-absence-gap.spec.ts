import {
  andOutsideAbsenceGap,
  insideAbsenceGapPredicate,
  isInsideAbsenceGap,
  reseatHistoryWindow,
} from './group-absence-gap';
import { withinViewerMembershipPredicate } from './message-visibility-predicates';
import {
  groupJoinHistoryFloorCoversPredicate,
  isCoveredByGroupJoinHistoryFloor,
} from './group-join-history-floor';

/**
 * SEC-25: a member who leaves a group and takes the seat back reads the
 * history up to the moment they left (minus what they cleared) and nothing
 * posted between leaving and returning, attachments included.
 */

const CLEARED_AT = new Date('2026-03-01T00:00:00.000Z');
const LEFT_AT = new Date('2026-03-10T00:00:00.000Z');
const RESEATED_AT = new Date('2026-03-20T00:00:00.000Z');

function seatWithGap() {
  return {
    absenceStartedAt: LEFT_AT,
    absenceEndedAt: RESEATED_AT,
  };
}

/** The visibility every history read composes for a seat: the clear floor,
 *  the `leftAt` ceiling and the absence gap. */
function isVisible(
  createdAt: Date,
  seat: {
    clearedAt: Date | null;
    leftAt: Date | null;
    absenceStartedAt: Date | null;
    absenceEndedAt: Date | null;
  },
): boolean {
  if (seat.clearedAt && createdAt <= seat.clearedAt) return false;
  if (seat.leftAt && createdAt > seat.leftAt) return false;
  return !isInsideAbsenceGap(createdAt, seat);
}

describe('reseatHistoryWindow', () => {
  it('keeps the clear point and records the stretch away as the gap', () => {
    expect(
      reseatHistoryWindow(
        {
          clearedAt: CLEARED_AT,
          leftAt: LEFT_AT,
          absenceStartedAt: null,
          absenceEndedAt: null,
        },
        RESEATED_AT,
      ),
    ).toEqual({
      clearedAt: CLEARED_AT,
      absenceStartedAt: LEFT_AT,
      absenceEndedAt: RESEATED_AT,
    });
  });

  it('shows history from before leaving and hides what was posted while away', () => {
    const window = reseatHistoryWindow(
      {
        clearedAt: CLEARED_AT,
        leftAt: LEFT_AT,
        absenceStartedAt: null,
        absenceEndedAt: null,
      },
      RESEATED_AT,
    );
    const seat = { ...window, leftAt: null };

    expect(isVisible(new Date('2026-02-15T00:00:00.000Z'), seat)).toBe(false);
    expect(isVisible(new Date('2026-03-05T00:00:00.000Z'), seat)).toBe(true);
    expect(isVisible(LEFT_AT, seat)).toBe(true);
    expect(isVisible(new Date('2026-03-15T00:00:00.000Z'), seat)).toBe(false);
    expect(isVisible(RESEATED_AT, seat)).toBe(false);
    expect(isVisible(new Date('2026-03-21T00:00:00.000Z'), seat)).toBe(true);
  });

  it('starts the gap at a clear made while away', () => {
    const clearedWhileAway = new Date('2026-03-12T00:00:00.000Z');
    expect(
      reseatHistoryWindow(
        {
          clearedAt: clearedWhileAway,
          leftAt: LEFT_AT,
          absenceStartedAt: null,
          absenceEndedAt: null,
        },
        RESEATED_AT,
      ),
    ).toEqual({
      clearedAt: clearedWhileAway,
      absenceStartedAt: clearedWhileAway,
      absenceEndedAt: RESEATED_AT,
    });
  });

  it('raises the clear point past an earlier gap on a second return, keeping the second gap hidden', () => {
    const secondLeftAt = new Date('2026-04-01T00:00:00.000Z');
    const secondReseatedAt = new Date('2026-04-10T00:00:00.000Z');
    const window = reseatHistoryWindow(
      {
        clearedAt: CLEARED_AT,
        leftAt: secondLeftAt,
        absenceStartedAt: LEFT_AT,
        absenceEndedAt: RESEATED_AT,
      },
      secondReseatedAt,
    );

    expect(window).toEqual({
      clearedAt: RESEATED_AT,
      absenceStartedAt: secondLeftAt,
      absenceEndedAt: secondReseatedAt,
    });
    const seat = { ...window, leftAt: null };
    // The first absence stays hidden, under the raised clear point.
    expect(isVisible(new Date('2026-03-15T00:00:00.000Z'), seat)).toBe(false);
    // The stretch between the two absences stays readable.
    expect(isVisible(new Date('2026-03-25T00:00:00.000Z'), seat)).toBe(true);
    // The second absence is hidden.
    expect(isVisible(new Date('2026-04-05T00:00:00.000Z'), seat)).toBe(false);
  });

  it('leaves a seat that never left as it is', () => {
    expect(
      reseatHistoryWindow(
        {
          clearedAt: CLEARED_AT,
          leftAt: null,
          absenceStartedAt: null,
          absenceEndedAt: null,
        },
        RESEATED_AT,
      ),
    ).toEqual({
      clearedAt: CLEARED_AT,
      absenceStartedAt: null,
      absenceEndedAt: null,
    });
  });
});

describe('the absence gap predicates', () => {
  it('bounds the gap exclusively at its start and inclusively at its end', () => {
    expect(isInsideAbsenceGap(LEFT_AT, seatWithGap())).toBe(false);
    expect(isInsideAbsenceGap(RESEATED_AT, seatWithGap())).toBe(true);
    expect(
      isInsideAbsenceGap(new Date('2026-03-15T00:00:00.000Z'), {
        absenceStartedAt: null,
        absenceEndedAt: null,
      }),
    ).toBe(false);
  });

  it('reads both raw columns off the seat alias', () => {
    const sql = insideAbsenceGapPredicate('m.created_at', 'p');
    expect(sql).toContain('p.absence_started_at IS NOT NULL');
    expect(sql).toContain('m.created_at > p.absence_started_at');
    expect(sql).toContain('m.created_at <= p.absence_ended_at');
  });

  it("answers the leftAt ceiling and the gap in one probe of the viewer's own seat", () => {
    const sql = withinViewerMembershipPredicate('m', ':viewerId');
    expect(sql.trim().startsWith('NOT EXISTS')).toBe(true);
    expect(sql.match(/conversation_participants/g)).toHaveLength(1);
    expect(sql).toContain('"viewer_seat"."user_id" = :viewerId');
    expect(sql).toContain('m.created_at > "viewer_seat"."left_at"');
    expect(sql).toContain('m.created_at > "viewer_seat".absence_started_at');
  });

  it('adds a bound clause only for a seat with a gap', () => {
    const andWhere = jest.fn();
    const queryBuilder = { andWhere };
    andOutsideAbsenceGap(queryBuilder as never, 'm.created_at', {
      absenceStartedAt: null,
      absenceEndedAt: null,
    });
    expect(andWhere).not.toHaveBeenCalled();

    andOutsideAbsenceGap(queryBuilder as never, 'm.created_at', seatWithGap());
    expect(andWhere).toHaveBeenCalledWith(
      'NOT (m.created_at > :absenceStartedAt AND m.created_at <= :absenceEndedAt)',
      {
        absenceStartedAt: LEFT_AT.toISOString(),
        absenceEndedAt: RESEATED_AT.toISOString(),
      },
    );
  });

  it('folds the gap into the join floor, so quotes, reactions, forwards, downloads and live frames skip it', () => {
    expect(
      groupJoinHistoryFloorCoversPredicate('message.created_at', 'seat'),
    ).toContain(insideAbsenceGapPredicate('message.created_at', 'seat'));
    expect(
      isCoveredByGroupJoinHistoryFloor(new Date('2026-03-15T00:00:00.000Z'), {
        historyFloorAt: null,
        isGroupConversation: true,
        ...seatWithGap(),
      }),
    ).toBe(true);
    expect(
      isCoveredByGroupJoinHistoryFloor(new Date('2026-03-05T00:00:00.000Z'), {
        historyFloorAt: null,
        isGroupConversation: true,
        ...seatWithGap(),
      }),
    ).toBe(false);
  });
});
