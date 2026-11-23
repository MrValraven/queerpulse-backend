import type { SelectQueryBuilder } from 'typeorm';
import { excludeSelfHiddenAttendees } from './attendee-roster-visibility';

interface RecordedWhere {
  clause: string;
  parameters: Record<string, unknown>;
}

// A query builder stub that records each `andWhere` clause and its parameters.
function recordingQueryBuilder(): {
  queryBuilder: SelectQueryBuilder<object>;
  recorded: RecordedWhere[];
} {
  const recorded: RecordedWhere[] = [];
  const stub = {
    andWhere: (clause: string, parameters: Record<string, unknown>) => {
      recorded.push({ clause, parameters });
      return stub;
    },
  };
  return {
    queryBuilder: stub as unknown as SelectQueryBuilder<object>,
    recorded,
  };
}

describe('excludeSelfHiddenAttendees', () => {
  it('binds the viewer so their own hidden row stays in the result', () => {
    const { queryBuilder, recorded } = recordingQueryBuilder();

    excludeSelfHiddenAttendees(queryBuilder, 'viewer-1', 'r');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.clause).toContain(
      '"r"."user_id" = :attendeeSelfHideViewerId',
    );
    expect(recorded[0]!.parameters).toEqual({
      attendeeSelfHideViewerId: 'viewer-1',
    });
  });

  it('drops a row whose profile has a live hidden_until for any other viewer', () => {
    const { queryBuilder, recorded } = recordingQueryBuilder();

    excludeSelfHiddenAttendees(queryBuilder, 'viewer-2', 'r');

    const { clause, parameters } = recorded[0]!;
    expect(clause).toContain('NOT EXISTS');
    expect(clause).toContain('FROM "profiles" "__attendee_self_hide"');
    expect(clause).toContain(
      '"__attendee_self_hide"."user_id" = "r"."user_id"',
    );
    expect(clause).toContain('"__attendee_self_hide"."hidden_until" > now()');
    expect(parameters).toEqual({ attendeeSelfHideViewerId: 'viewer-2' });
  });

  it('reads the rsvp alias it is handed', () => {
    const { queryBuilder, recorded } = recordingQueryBuilder();

    excludeSelfHiddenAttendees(queryBuilder, 'viewer-1', 'rsvp');

    expect(recorded[0]!.clause).toContain('"rsvp"."user_id"');
    expect(recorded[0]!.clause).not.toContain('"r"."user_id"');
  });
});
