import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  ADMIN_PREVIEW_COLUMNS_SQL,
  AdminStudioLandingPreviewsService,
  LOCK_PREVIEWS_SQL,
  OPEN_PREVIEW_COUNT_SQL,
  REACHABLE_OWNER_SQL,
  TRACK_ELIGIBILITY_SQL,
} from './admin-studio-landing-previews.service';
import {
  AdminLandingPreviewRow,
  AdminLandingTrackOptionRow,
} from './admin-studio-landing-response';
import {
  resetStudioLandingMemoForTesting,
  studioLandingMemoGeneration,
} from './studio-landing-memo';
import { STUDIO_LIMITS } from './studio.constants';
import { STUDIO_LANDING_PREVIEW_REQUESTED } from './studio.events';

const STAFF_ID = 'e9100000-0000-4000-8000-000000000001';
const OWNER_ID = 'e9100000-0000-4000-8000-000000000002';
const TRACK_ID = 'e9100000-0000-4000-8000-000000000011';
const PERSONA_ID = 'e9100000-0000-4000-8000-000000000021';
const RELEASE_ID = 'e9100000-0000-4000-8000-000000000031';
const PREVIEW_ID = 'e9100000-0000-4000-8000-000000000041';
const SECOND_PREVIEW = 'e9100000-0000-4000-8000-000000000042';

async function responseOf(
  promise: Promise<unknown>,
): Promise<Record<string, unknown> | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as HttpException).getResponse() as Record<string, unknown>;
  }
}

function previewRow(
  overrides: Partial<AdminLandingPreviewRow> = {},
): AdminLandingPreviewRow {
  return {
    id: PREVIEW_ID,
    status: 'pending',
    position: 1,
    track_id: TRACK_ID,
    track_title: 'Lisbon at four',
    track_duration_seconds: 212,
    release_id: RELEASE_ID,
    release_title: 'Night bus',
    release_cover_key: null,
    artist_id: PERSONA_ID,
    artist_handle: 'night-bus',
    artist_display_name: 'Night Bus',
    artist_kind: 'artist',
    artist_avatar_url: null,
    ineligible_reason: null,
    requested_by_id: STAFF_ID,
    requested_at: new Date('2026-10-28T09:00:00.000Z'),
    decided_by_id: null,
    decided_at: null,
    ...overrides,
  };
}

describe('AdminStudioLandingPreviewsService', () => {
  let dataSourceQuery: jest.Mock;
  let managerQuery: jest.Mock;
  let previewRepository: { delete: jest.Mock };
  let modAudit: { namesForUserIds: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: AdminStudioLandingPreviewsService;
  let eligibilityRows: {
    ineligible_reason: string | null;
    release_persona_id: string;
  }[];
  let countRow: { open_count: number; track_open_count: number };
  let reachableRows: { '?column?': number }[];
  let openIdRows: { id: string }[];
  let insertError: Error | undefined;
  let openRows: AdminLandingPreviewRow[];
  let decidedRows: AdminLandingPreviewRow[];
  let byIdRows: AdminLandingPreviewRow[];
  let isTransactionResolved: boolean;
  let transactionResolvedBeforeEmit: boolean | undefined;

  const trackEligibility = (
    rows: { ineligible_reason: string | null; release_persona_id: string }[],
  ) => {
    eligibilityRows = rows;
  };

  beforeEach(() => {
    resetStudioLandingMemoForTesting();
    eligibilityRows = [
      { ineligible_reason: null, release_persona_id: PERSONA_ID },
    ];
    countRow = { open_count: 3, track_open_count: 0 };
    reachableRows = [{ '?column?': 1 }];
    openIdRows = [{ id: PREVIEW_ID }, { id: SECOND_PREVIEW }];
    insertError = undefined;
    openRows = [];
    decidedRows = [];
    byIdRows = [previewRow()];
    isTransactionResolved = false;
    transactionResolvedBeforeEmit = undefined;

    managerQuery = jest.fn((sql: string) => {
      if (sql === LOCK_PREVIEWS_SQL) {
        return Promise.resolve([]);
      }
      if (sql === TRACK_ELIGIBILITY_SQL) {
        return Promise.resolve(eligibilityRows);
      }
      if (sql === OPEN_PREVIEW_COUNT_SQL) {
        return Promise.resolve([countRow]);
      }
      if (sql === REACHABLE_OWNER_SQL) {
        return Promise.resolve(reachableRows);
      }
      if (sql.startsWith('INSERT INTO "studio_landing_previews"')) {
        return insertError
          ? Promise.reject(insertError)
          : Promise.resolve([{ id: PREVIEW_ID }]);
      }
      if (sql.startsWith('SELECT "id" FROM "studio_landing_previews"')) {
        return Promise.resolve(openIdRows);
      }
      return Promise.resolve([]);
    });
    dataSourceQuery = jest.fn((sql: string) => {
      if (sql.includes('WHERE "preview"."id" = $1')) {
        return Promise.resolve(byIdRows);
      }
      if (sql.includes(`IN ('declined', 'withdrawn')`)) {
        return Promise.resolve(decidedRows);
      }
      if (sql.includes(`"preview"."status" IN ('pending', 'approved')`)) {
        return Promise.resolve(openRows);
      }
      return Promise.resolve([]);
    });
    previewRepository = {
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    };
    modAudit = {
      namesForUserIds: jest.fn((userIds: string[]) =>
        Promise.resolve(
          new Map(
            userIds.map((userId) => [
              userId,
              userId === STAFF_ID ? 'Rita Staff' : 'Owner Name',
            ]),
          ),
        ),
      ),
    };
    eventEmitter = {
      emit: jest.fn(() => {
        transactionResolvedBeforeEmit = isTransactionResolved;
        return true;
      }),
    };
    const dataSource = {
      query: dataSourceQuery,
      transaction: jest.fn(
        async (work: (inner: EntityManager) => Promise<unknown>) => {
          const result = await work({
            query: managerQuery,
          } as unknown as EntityManager);
          isTransactionResolved = true;
          return result;
        },
      ),
      getRepository: jest.fn(() => previewRepository),
    };
    service = new AdminStudioLandingPreviewsService(
      dataSource as unknown as DataSource,
      modAudit as unknown as ModAuditService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('the SQL', () => {
    it('reads the staff columns with the first failing reason and the release persona', () => {
      expect(ADMIN_PREVIEW_COLUMNS_SQL).toContain('AS "ineligible_reason"');
      expect(ADMIN_PREVIEW_COLUMNS_SQL).toContain('AS "artist_id"');
      expect(ADMIN_PREVIEW_COLUMNS_SQL).toContain(
        '"preview"."created_at" AS "requested_at"',
      );
      expect(TRACK_ELIGIBILITY_SQL).toContain(
        '"release"."subprofile_id" AS "release_persona_id"',
      );
      expect(TRACK_ELIGIBILITY_SQL).toContain('WHERE "track"."id" = $1');
    });

    it('reaches an owner through the grant holders of the persona', () => {
      expect(REACHABLE_OWNER_SQL).toMatch(/^SELECT 1 FROM \(/);
      expect(REACHABLE_OWNER_SQL).toContain('"studio_access_grants"');
      expect(REACHABLE_OWNER_SQL).toContain('"reachable_owner" LIMIT 1');
    });
  });

  describe('requestPreview', () => {
    it('takes the share row exclusive lock before reading the open rows', async () => {
      await service.requestPreview(STAFF_ID, TRACK_ID);
      expect(managerQuery.mock.calls[0]?.[0]).toBe(LOCK_PREVIEWS_SQL);
      expect(LOCK_PREVIEWS_SQL).toBe(
        'LOCK TABLE "studio_landing_previews" IN SHARE ROW EXCLUSIVE MODE',
      );
    });

    it('refuses an ineligible track with studio_landing_preview_track_not_eligible and its reason', async () => {
      trackEligibility([
        {
          ineligible_reason: 'content_warnings',
          release_persona_id: PERSONA_ID,
        },
      ]);
      await expect(
        service.requestPreview(STAFF_ID, TRACK_ID),
      ).rejects.toMatchObject({
        response: {
          statusCode: 422,
          code: 'studio_landing_preview_track_not_eligible',
          ineligibleReason: 'content_warnings',
        },
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('reads an unknown track as not_playable', async () => {
      trackEligibility([]);
      expect(
        await responseOf(service.requestPreview(STAFF_ID, TRACK_ID)),
      ).toMatchObject({
        statusCode: 422,
        code: 'studio_landing_preview_track_not_eligible',
        ineligibleReason: 'not_playable',
      });
    });

    it('refuses a second open request for a track with studio_landing_preview_exists', async () => {
      countRow = { open_count: 3, track_open_count: 1 };
      expect(
        (await responseOf(service.requestPreview(STAFF_ID, TRACK_ID)))?.code,
      ).toBe('studio_landing_preview_exists');
    });

    it('maps a unique violation on the open track index to studio_landing_preview_exists', async () => {
      insertError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'UQ_studio_landing_previews_open_track',
      });
      expect(
        await responseOf(service.requestPreview(STAFF_ID, TRACK_ID)),
      ).toMatchObject({
        statusCode: 409,
        code: 'studio_landing_preview_exists',
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses an eleventh open preview with studio_landing_previews_full', async () => {
      countRow = {
        open_count: STUDIO_LIMITS.landingOpenPreviewsMax,
        track_open_count: 0,
      };
      expect(
        (await responseOf(service.requestPreview(STAFF_ID, TRACK_ID)))?.code,
      ).toBe('studio_landing_previews_full');
    });

    it('refuses a track whose owners hold no Studio grant with studio_landing_preview_no_reachable_owner', async () => {
      reachableRows = [];
      expect(
        (await responseOf(service.requestPreview(STAFF_ID, TRACK_ID)))?.code,
      ).toBe('studio_landing_preview_no_reachable_owner');
      expect(managerQuery).toHaveBeenCalledWith(REACHABLE_OWNER_SQL, [
        PERSONA_ID,
      ]);
    });

    it('places a new request after the last open position and emits it after commit', async () => {
      const preview = await service.requestPreview(STAFF_ID, TRACK_ID);
      expect(managerQuery).toHaveBeenCalledWith(
        expect.stringContaining('COALESCE(MAX("position"), 0) + 1'),
        [TRACK_ID, STAFF_ID],
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        STUDIO_LANDING_PREVIEW_REQUESTED,
        { previewId: PREVIEW_ID },
      );
      expect(transactionResolvedBeforeEmit).toBe(true);
      expect(studioLandingMemoGeneration()).toBe(1);
      expect(preview).toMatchObject({
        id: PREVIEW_ID,
        status: 'pending',
        isOnLanding: false,
        requestedBy: { id: STAFF_ID, displayName: 'Rita Staff' },
        decidedBy: null,
      });
    });
  });

  describe('reorderPreviews', () => {
    it('answers studio_landing_order_mismatch when the reorder leaves out an open preview', async () => {
      expect(
        (await responseOf(service.reorderPreviews([SECOND_PREVIEW])))?.code,
      ).toBe('studio_landing_order_mismatch');
      expect(managerQuery.mock.calls[0]?.[0]).toBe(LOCK_PREVIEWS_SQL);
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('rewrites the open positions to 1..n in one statement', async () => {
      openRows = [
        previewRow({ id: SECOND_PREVIEW, position: 1 }),
        previewRow({ id: PREVIEW_ID, position: 2 }),
      ];
      const previews = await service.reorderPreviews([
        SECOND_PREVIEW,
        PREVIEW_ID,
      ]);
      const updateCalls = managerQuery.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].startsWith('UPDATE'),
      );
      expect(updateCalls).toEqual([
        [
          expect.stringContaining(
            'FROM unnest($1::uuid[]) WITH ORDINALITY AS "ordered"("id", "position")',
          ),
          [[SECOND_PREVIEW, PREVIEW_ID]],
        ],
      ]);
      expect(previews.map((preview) => preview.id)).toEqual([
        SECOND_PREVIEW,
        PREVIEW_ID,
      ]);
      expect(studioLandingMemoGeneration()).toBe(1);
    });
  });

  describe('listPreviews', () => {
    it('lists open rows by position, then up to 30 decided rows newest first, marking the first five live', async () => {
      openRows = Array.from({ length: 7 }, (_unused, index) =>
        previewRow({
          id: `e9100000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
          status: 'approved',
          position: index + 1,
          ineligible_reason: index === 1 ? 'explicit' : null,
          decided_by_id: OWNER_ID,
          decided_at: new Date('2026-10-28T10:00:00.000Z'),
        }),
      );
      decidedRows = [
        previewRow({
          id: SECOND_PREVIEW,
          status: 'declined',
          position: 3,
          decided_by_id: OWNER_ID,
          decided_at: new Date('2026-10-27T10:00:00.000Z'),
        }),
      ];
      const previews = await service.listPreviews();
      expect(dataSourceQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          'ORDER BY "preview"."decided_at" DESC NULLS LAST, "preview"."id" ASC',
        ),
        [STUDIO_LIMITS.landingDecidedPreviewsShown],
      );
      expect(dataSourceQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          'ORDER BY "preview"."position" ASC, "preview"."id" ASC',
        ),
      );
      expect(STUDIO_LIMITS.landingDecidedPreviewsShown).toBe(30);
      expect(
        previews.map((preview) => [
          preview.position,
          preview.status,
          preview.ineligibleReason,
          preview.isOnLanding,
        ]),
      ).toEqual([
        [1, 'approved', null, true],
        [2, 'approved', 'explicit', false],
        [3, 'approved', null, true],
        [4, 'approved', null, true],
        [5, 'approved', null, true],
        [6, 'approved', null, true],
        [7, 'approved', null, false],
        [3, 'declined', null, false],
      ]);
      expect(modAudit.namesForUserIds).toHaveBeenCalledTimes(1);
      expect(modAudit.namesForUserIds).toHaveBeenCalledWith(
        expect.arrayContaining([STAFF_ID, OWNER_ID]),
      );
      expect(previews[7]?.decidedBy).toEqual({
        id: OWNER_ID,
        displayName: 'Owner Name',
      });
    });
  });

  describe('searchTracks', () => {
    it('matches the folded escaped query and reads the open preview flag', async () => {
      const optionRow: AdminLandingTrackOptionRow = {
        track_id: TRACK_ID,
        track_title: 'Lisbon at four',
        track_duration_seconds: 212,
        release_id: RELEASE_ID,
        release_title: 'Night bus',
        release_cover_key: null,
        artist_id: PERSONA_ID,
        artist_handle: 'night-bus',
        artist_display_name: 'Night Bus',
        artist_kind: 'artist',
        artist_avatar_url: null,
        ineligible_reason: 'podcast',
        has_open_preview: true,
      };
      dataSourceQuery.mockResolvedValueOnce([optionRow]);
      const result = await service.searchTracks('  50%_off ');
      expect(dataSourceQuery).toHaveBeenCalledWith(
        expect.stringContaining('AS "has_open_preview"'),
        ['%50\\%\\_off%', 20],
      );
      expect(
        result.items.map((item) => [
          item.track.id,
          item.ineligibleReason,
          item.hasOpenPreview,
        ]),
      ).toEqual([[TRACK_ID, 'podcast', true]]);
    });
  });

  describe('removePreview', () => {
    it('deletes a preview in any status, answers studio_landing_preview_not_found when unknown and bumps the memo', async () => {
      await service.removePreview(PREVIEW_ID);
      expect(previewRepository.delete).toHaveBeenCalledWith({ id: PREVIEW_ID });
      expect(studioLandingMemoGeneration()).toBe(1);

      previewRepository.delete.mockResolvedValueOnce({ affected: 0, raw: [] });
      expect(
        await responseOf(service.removePreview(SECOND_PREVIEW)),
      ).toMatchObject({
        statusCode: 404,
        code: 'studio_landing_preview_not_found',
      });
      expect(studioLandingMemoGeneration()).toBe(1);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
