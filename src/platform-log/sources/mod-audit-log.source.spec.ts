import type { Repository } from 'typeorm';
import type { ModAuditLog } from '../../moderation/entities/mod-audit-log.entity';
import { MOD_STAFF_ACTIONS, type SourceWindow } from '../platform-log.types';
import {
  ModAuditLogSource,
  type ModAuditViewerRule,
} from './mod-audit-log.source';

type QueryBuilderMethod =
  | 'select'
  | 'addSelect'
  | 'where'
  | 'andWhere'
  | 'orderBy'
  | 'addOrderBy'
  | 'limit'
  | 'leftJoin'
  | 'innerJoin';
type QueryBuilderStub = Record<QueryBuilderMethod, jest.Mock> & {
  getRawMany: jest.Mock;
};

function queryBuilderStub(
  rows: Record<string, unknown>[] = [],
): QueryBuilderStub {
  const methods: QueryBuilderMethod[] = [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'leftJoin',
    'innerJoin',
  ];
  const queryBuilder = {} as QueryBuilderStub;
  for (const method of methods) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

function windowWith(overrides: Partial<SourceWindow> = {}): SourceWindow {
  return {
    cursor: null,
    since: null,
    limit: 30,
    memberId: null,
    staffRowsOnly: false,
    categories: ['moderation', 'staff', 'governance', 'reviews', 'members'],
    ...overrides,
  };
}

function conditionsOf(queryBuilder: QueryBuilderStub): string[] {
  return queryBuilder.andWhere.mock.calls.map(([sql]) => String(sql));
}

const ROW = {
  row_id: 'row-1',
  occurred_at_exact: '2026-10-05T12:00:00.123456Z',
  action: 'ban',
  actor_id: 'staff-1',
  target_user_id: 'member-1',
  target_name: 'Bea Lopes',
  report_id: 'report-1',
  reason_code: 'harassment',
  duration: null,
  note: 'Repeated slurs.',
};

const NO_VIEWER_RULE: ModAuditViewerRule = {
  auditFeedViewer: () => undefined,
};

function sourceWith(
  rows: Record<string, unknown>[] = [],
  moderation: ModAuditViewerRule = NO_VIEWER_RULE,
) {
  const queryBuilder = queryBuilderStub(rows);
  const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
  const source = new ModAuditLogSource(
    repository as unknown as Repository<ModAuditLog>,
    moderation,
  );
  return { source, queryBuilder, repository };
}

describe('ModAuditLogSource', () => {
  it('skips the query when neither of its categories is requested', async () => {
    const { source, repository } = sourceWith();
    expect(await source.fetch(windowWith({ categories: ['members'] }))).toEqual(
      [],
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('keeps only staff actions when only Staff & access is requested', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ categories: ['staff'] }));
    expect(conditionsOf(queryBuilder)).toContain(
      '"e"."action" IN (:...modStaffActions)',
    );
  });

  it('excludes staff actions when only Moderation is requested', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ categories: ['moderation'] }));
    expect(conditionsOf(queryBuilder)).toContain(
      '"e"."action" NOT IN (:...modStaffActions)',
    );
  });

  it('filters by member as actor or target', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'member-1' }));
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '("e"."actor_id" = :memberId OR "e"."target_user_id" = :memberId)',
      { memberId: 'member-1' },
    );
  });

  it('maps a report action with its snapshot, params and report link', async () => {
    const { source } = sourceWith([ROW]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toEqual({
      sourceKey: 'mod',
      rowId: 'row-1',
      occurredAtExact: ROW.occurred_at_exact,
      category: 'moderation',
      kind: 'mod.ban',
      actorUserId: 'staff-1',
      actorFallbackName: null,
      actorKind: 'staff',
      targetUserId: 'member-1',
      targetFallbackName: 'Bea Lopes',
      subject: { label: '', route: '/admin/moderation' },
      params: { reasonCode: 'harassment' },
      note: 'Repeated slurs.',
    });
  });

  it('files staff actions under Staff & access and unknown actions under Moderation', async () => {
    const { source } = sourceWith([
      { ...ROW, row_id: 'a', action: 'conversation_context_viewed' },
      { ...ROW, row_id: 'b', action: 'something_new_next_year' },
    ]);
    const entries = await source.fetch(windowWith());
    expect(entries.map((entry) => entry.category)).toEqual([
      'staff',
      'moderation',
    ]);
  });

  it('marks a null-actor ban hold expiry as a system action', async () => {
    const { source } = sourceWith([
      { ...ROW, action: 'ban_hold_expired', actor_id: null },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry?.actorKind).toBe('system');
  });
});

describe('ModAuditLogSource creator draft views', () => {
  it('files a creator draft view under Staff and access with the kind and no note', async () => {
    const { source } = sourceWith([
      {
        ...ROW,
        action: 'creator_draft_viewed',
        target_user_id: null,
        target_name: null,
        report_id: null,
        note: '{"v":1,"kind":"listing_edit","draftId":"draft-1","surface":"creator_drafts"}',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toEqual(
      expect.objectContaining({
        category: 'staff',
        kind: 'mod.creator_draft_viewed',
        targetUserId: null,
        params: { draftKind: 'listing_edit' },
        note: null,
        subject: { label: '', route: '/admin/creator-drafts' },
      }),
    );
  });

  it('keeps an unreadable creator draft note out of the entry', async () => {
    const { source } = sourceWith([
      { ...ROW, action: 'creator_draft_viewed', note: 'garbled' },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry?.params).toEqual({});
    expect(entry?.note).toBeNull();
  });

  it('lists the action among the staff actions', () => {
    expect(MOD_STAFF_ACTIONS).toContain('creator_draft_viewed');
  });
});

describe('ModAuditLogSource for a reported staff member (SEC-31)', () => {
  const VIEWER_ID = '11111111-1111-4111-8111-111111111111';

  interface ViewerRuleState {
    viewerIdsAsked: (string | undefined)[];
    reportIdBatches: string[][];
  }

  function viewerRule(state: ViewerRuleState): ModAuditViewerRule {
    return {
      auditFeedViewer: (actorId) => {
        state.viewerIdsAsked.push(actorId);
        if (!actorId) return undefined;
        return {
          userId: actorId,
          reportIdsAboutViewer: (reportIds) => {
            state.reportIdBatches.push(reportIds);
            return Promise.resolve(
              new Set(
                reportIds.filter((reportId) =>
                  reportId.startsWith('report-about-viewer'),
                ),
              ),
            );
          },
        };
      },
    };
  }

  it('excludes in SQL the rows a report or citation ties to the viewer', async () => {
    const state: ViewerRuleState = { viewerIdsAsked: [], reportIdBatches: [] };
    const { source, queryBuilder } = sourceWith([], viewerRule(state));
    await source.fetch(windowWith({ viewerUserId: VIEWER_ID }));

    expect(state.viewerIdsAsked).toEqual([VIEWER_ID]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('e.targetUserId'),
      { viewerUserId: VIEWER_ID },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("e.action <> 'evidence_cited'"),
      { viewerUserId: VIEWER_ID },
    );
  });

  it('drops the rows on a report about the viewer and keeps the rest', async () => {
    const state: ViewerRuleState = { viewerIdsAsked: [], reportIdBatches: [] };
    const { source } = sourceWith(
      [
        { ...ROW, row_id: 'about-viewer', report_id: 'report-about-viewer' },
        { ...ROW, row_id: 'about-other', report_id: 'report-about-other' },
        { ...ROW, row_id: 'platform', report_id: null },
      ],
      viewerRule(state),
    );
    const entries = await source.fetch(windowWith({ viewerUserId: VIEWER_ID }));

    expect(entries.map((entry) => entry.rowId)).toEqual([
      'about-other',
      'platform',
    ]);
    expect(state.reportIdBatches).toEqual([
      ['report-about-viewer', 'report-about-other'],
    ]);
  });

  it('reads past a full batch that lost rows so the page stays full', async () => {
    const state: ViewerRuleState = { viewerIdsAsked: [], reportIdBatches: [] };
    const firstBatch = [
      { ...ROW, row_id: 'kept-1', report_id: null },
      {
        ...ROW,
        row_id: 'dropped',
        occurred_at_exact: '2026-10-05T11:00:00.000000Z',
        report_id: 'report-about-viewer',
      },
    ];
    const secondBatch = [
      {
        ...ROW,
        row_id: 'kept-2',
        occurred_at_exact: '2026-10-05T10:00:00.000000Z',
        report_id: null,
      },
    ];
    const { source, queryBuilder } = sourceWith([], viewerRule(state));
    queryBuilder.getRawMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);

    const entries = await source.fetch(
      windowWith({ limit: 1, viewerUserId: VIEWER_ID }),
    );

    expect(entries.map((entry) => entry.rowId)).toEqual(['kept-1', 'kept-2']);
    expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(2);
    // The second read starts after the last raw row of the first.
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(':platformLogCursorRowId'),
      {
        platformLogCursorTime: '2026-10-05T11:00:00.000000Z',
        platformLogCursorRowId: 'dropped',
      },
    );
  });

  it('reads once and adds no viewer filter when no viewer is given', async () => {
    const { source, queryBuilder } = sourceWith([ROW]);
    await source.fetch(windowWith());

    expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(1);
    expect(conditionsOf(queryBuilder).join(' ')).not.toContain('viewerUserId');
  });
});
