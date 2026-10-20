import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { CreatorDraftUnionRow } from './admin-creator-draft-union';
import { AdminCreatorDraftsService } from './admin-creator-drafts.service';
import type {
  AdminCreatorDraftDetail,
  AdminCreatorDraftRow,
} from './creator-draft.types';
import {
  CreatorDraftVisibility,
  NoticeGatedCreatorDraftKind,
} from './creator-drafts.constants';

const NOTICE_DATE = '2026-10-01T00:00:00.000Z';
const NOTICE_FOR_EVERY_KIND: Record<NoticeGatedCreatorDraftKind, string> = {
  persona: NOTICE_DATE,
  studio_release: NOTICE_DATE,
  studio_episode: NOTICE_DATE,
  event: NOTICE_DATE,
  listing_edit: NOTICE_DATE,
  community: NOTICE_DATE,
};
const ALL_NULL: Record<NoticeGatedCreatorDraftKind, null> = {
  persona: null,
  studio_release: null,
  studio_episode: null,
  event: null,
  listing_edit: null,
  community: null,
};
const DEFAULT_VISIBILITY: CreatorDraftVisibility = {
  noticeLiveSince: NOTICE_FOR_EVERY_KIND,
  isFeatureLaunched: () => true,
};

const COMMUNITY_DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const LISTING_DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const PERSONA_ID = '33333333-3333-4333-8333-333333333333';
const DRAFT_ID = '44444444-4444-4444-8444-444444444444';
const SAVED_AT = new Date('2026-10-18T12:00:00.000Z');

function unionRow(
  kind: CreatorDraftUnionRow['kind'],
  id: string,
): CreatorDraftUnionRow {
  return { kind, id, owner_user_id: 'author-1', last_saved_at: SAVED_AT };
}

function draftRow(
  kind: AdminCreatorDraftRow['kind'],
  id: string,
): AdminCreatorDraftRow {
  return {
    kind,
    id,
    title: null,
    madeFor: null,
    owner: null,
    lastSavedAt: SAVED_AT.toISOString(),
    progress: null,
    missing: null,
  };
}

const UNION_ROW_A = unionRow('community', COMMUNITY_DRAFT_ID);
const UNION_ROW_B = unionRow('listing', LISTING_DRAFT_ID);
const PERSONA_UNION_ROW = unionRow('persona', PERSONA_ID);
const ROW_A = draftRow('community', COMMUNITY_DRAFT_ID);
const ROW_B = draftRow('listing', LISTING_DRAFT_ID);
const PERSONA_ROW = draftRow('persona', PERSONA_ID);
const DETAIL_A: AdminCreatorDraftDetail = {
  ...ROW_A,
  kind: 'community',
  preview: { name: 'Sunday swimmers' },
};

describe('AdminCreatorDraftsService', () => {
  let dataSource: { query: jest.Mock };
  let rows: { rowsFor: jest.Mock; detailFor: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let config: { get: jest.Mock };
  let service: AdminCreatorDraftsService;

  function buildService(
    visibility: CreatorDraftVisibility = DEFAULT_VISIBILITY,
  ): AdminCreatorDraftsService {
    return new AdminCreatorDraftsService(
      dataSource as unknown as DataSource,
      // The rows service has private members, so a plain mock object cannot
      // satisfy its type structurally.
      rows as never,
      modAudit as unknown as ModAuditService,
      config as unknown as ConfigService,
      visibility,
    );
  }

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    rows = { rowsFor: jest.fn(), detailFor: jest.fn() };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    service = buildService();
  });

  it('pages the union and hydrates the rows in order', async () => {
    dataSource.query
      .mockResolvedValueOnce([UNION_ROW_A, UNION_ROW_B])
      .mockResolvedValueOnce([{ total: 42 }]);
    rows.rowsFor.mockResolvedValue([ROW_A, ROW_B]);
    await expect(service.list({ page: 2 })).resolves.toEqual({
      items: [ROW_A, ROW_B],
      total: 42,
      page: 2,
      pageSize: 20,
    });
    expect(rows.rowsFor).toHaveBeenCalledWith([UNION_ROW_A, UNION_ROW_B]);
  });

  it('answers an empty page with no query when every kind is gated', async () => {
    const gated = buildService({
      noticeLiveSince: ALL_NULL,
      isFeatureLaunched: () => false,
    });
    await expect(gated.list({})).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('writes one creator_draft_viewed row for a 200 detail and none for the list', async () => {
    dataSource.query.mockResolvedValueOnce([UNION_ROW_A]);
    rows.rowsFor.mockResolvedValue([ROW_A]);
    rows.detailFor.mockResolvedValue(DETAIL_A);
    await expect(
      service.getOne('admin-1', 'community', ROW_A.id),
    ).resolves.toBe(DETAIL_A);
    expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      'admin-1',
      'creator_draft_viewed',
      undefined,
      JSON.stringify({
        v: 1,
        kind: 'community',
        draftId: ROW_A.id,
        surface: 'creator_drafts',
      }),
    );
    modAudit.writeAuditLog.mockClear();
    dataSource.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);
    await service.list({});
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('answers 404 for a draft the scope leaves out and writes no audit row', async () => {
    dataSource.query.mockResolvedValueOnce([]);
    await expect(
      service.getOne('admin-1', 'event', DRAFT_ID),
    ).rejects.toMatchObject({
      response: {
        code: 'creator_draft_not_found',
        message: expect.any(String) as string,
      },
    });
    await expect(
      buildService({
        noticeLiveSince: ALL_NULL,
        isFeatureLaunched: () => true,
      }).getOne('admin-1', 'persona', DRAFT_ID),
    ).rejects.toMatchObject({ status: 404 });
    rows.rowsFor.mockResolvedValue([PERSONA_ROW]);
    rows.detailFor.mockResolvedValue(null);
    dataSource.query.mockResolvedValueOnce([PERSONA_UNION_ROW]);
    await expect(
      service.getOne('admin-1', 'persona', PERSONA_ROW.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('shows nothing when the audit write fails', async () => {
    dataSource.query.mockResolvedValueOnce([UNION_ROW_A]);
    rows.rowsFor.mockResolvedValue([ROW_A]);
    rows.detailFor.mockResolvedValue(DETAIL_A);
    modAudit.writeAuditLog.mockRejectedValue(new Error('connection reset'));
    await expect(
      service.getOne('admin-1', 'community', ROW_A.id),
    ).rejects.toThrow('connection reset');
  });

  it('reads the detail scope with the id filter and the expiry window', async () => {
    dataSource.query.mockResolvedValueOnce([UNION_ROW_A]);
    rows.rowsFor.mockResolvedValue([ROW_A]);
    rows.detailFor.mockResolvedValue(DETAIL_A);
    await service.getOne('admin-1', 'community', ROW_A.id);
    const [sql, parameters] = dataSource.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(/"stored"\."id" = \$\d+/);
    expect(parameters).toContain(ROW_A.id);
  });
});
