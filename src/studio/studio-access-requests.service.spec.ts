import { HttpException } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import {
  REQUEST_ACCESS_INSERT_SQL,
  StudioAccessRequestsService,
} from './studio-access-requests.service';
import { StudioAccessService } from './studio-access.service';
import {
  AccessRequestRow,
  decodeAccessRequestCursor,
  encodeAccessRequestCursor,
} from './studio-landing-response';

const STAFF_ID = 'fa000000-0000-4000-8000-000000000001';
const MEMBER_ID = 'fa000000-0000-4000-8000-000000000002';
const REQUEST_ID = 'fa100000-0000-4000-8000-000000000001';
const REQUESTED_AT = new Date('2026-10-28T09:00:00.123Z');
const GRANT_RESPONSE = {
  userId: MEMBER_ID,
  grantedAt: '2026-10-28T10:00:00.000Z',
  grantedBy: { id: STAFF_ID, displayName: 'Rita Lobo' },
};

function requestRow(index: number, wantsToRelease: boolean): AccessRequestRow {
  const suffix = String(index).padStart(12, '0');
  return {
    id: `fa200000-0000-4000-8000-${suffix}`,
    user_id: `fa300000-0000-4000-8000-${suffix}`,
    wants_to_release: wantsToRelease,
    is_from_invite: false,
    created_at: new Date(REQUESTED_AT.getTime() + index * 1000),
  };
}

async function errorCodeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { code?: string };
      return [error.getStatus(), body.code];
    }
    throw error;
  }
  return 'resolved';
}

describe('StudioAccessRequestsService', () => {
  let query: jest.Mock;
  let profiles: { find: jest.Mock };
  let access: { hasAccess: jest.Mock; grant: jest.Mock };
  let service: StudioAccessRequestsService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    profiles = { find: jest.fn().mockResolvedValue([]) };
    access = {
      hasAccess: jest.fn().mockResolvedValue(false),
      grant: jest.fn().mockResolvedValue(GRANT_RESPONSE),
    };
    service = new StudioAccessRequestsService(
      { query } as unknown as DataSource,
      profiles as unknown as Repository<Profile>,
      access as unknown as StudioAccessService,
    );
  });

  it('refuses a member who holds a grant with studio_access_already_granted', async () => {
    access.hasAccess.mockResolvedValue(true);
    expect(await errorCodeOf(service.requestAccess(MEMBER_ID, true))).toEqual([
      409,
      'studio_access_already_granted',
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a second request with studio_access_request_exists', async () => {
    query.mockResolvedValue([]);
    expect(await errorCodeOf(service.requestAccess(MEMBER_ID, false))).toEqual([
      409,
      'studio_access_request_exists',
    ]);
    expect(query).toHaveBeenCalledWith(REQUEST_ACCESS_INSERT_SQL, [
      MEMBER_ID,
      false,
    ]);
    expect(REQUEST_ACCESS_INSERT_SQL).toMatch(
      /WHERE NOT EXISTS \(SELECT 1 FROM "studio_access_grants" WHERE "user_id" = \$1::uuid\)/,
    );
  });

  it('answers studio_access_already_granted when a grant lands between the check and the insert', async () => {
    access.hasAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    query.mockResolvedValue([]);
    expect(await errorCodeOf(service.requestAccess(MEMBER_ID, true))).toEqual([
      409,
      'studio_access_already_granted',
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(access.hasAccess).toHaveBeenCalledTimes(2);
  });

  it('answers the new request state', async () => {
    query.mockResolvedValue([{ created_at: REQUESTED_AT }]);
    expect(await service.requestAccess(MEMBER_ID, true)).toEqual({
      hasPendingRequest: true,
      wantsToRelease: true,
      requestedAt: REQUESTED_AT.toISOString(),
    });
  });

  it('cancels idempotently', async () => {
    await service.cancelRequest(MEMBER_ID);
    await service.cancelRequest(MEMBER_ID);
    expect(query.mock.calls).toEqual([
      [
        'DELETE FROM "studio_access_requests" WHERE "user_id" = $1',
        [MEMBER_ID],
      ],
      [
        'DELETE FROM "studio_access_requests" WHERE "user_id" = $1',
        [MEMBER_ID],
      ],
    ]);
  });

  it('reads the caller own request and null without one', async () => {
    query.mockResolvedValueOnce([
      { wants_to_release: true, created_at: REQUESTED_AT },
    ]);
    query.mockResolvedValueOnce([]);
    expect([
      await service.findOwnRequest(MEMBER_ID),
      await service.findOwnRequest(MEMBER_ID),
    ]).toEqual([
      { wantsToRelease: true, requestedAt: REQUESTED_AT.toISOString() },
      null,
    ]);
  });

  it('pages artists first then oldest, thirty a page, and resumes after the last row', async () => {
    const rows = Array.from({ length: 31 }, (_unused, index) =>
      requestRow(index + 1, index < 10),
    );
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('COUNT(*)')
          ? [{ total_count: 45, artist_count: 10 }]
          : rows,
      ),
    );

    const page = await service.listWaiting(undefined);

    const pageSql = query.mock.calls
      .map((call: unknown[]) => call[0])
      .find(
        (sql): sql is string =>
          typeof sql === 'string' && sql.includes('LIMIT'),
      );
    expect(pageSql).toContain(
      'ORDER BY "request"."wants_to_release" DESC, "request"."created_at" ASC, "request"."id" ASC',
    );
    const thirtiethRow = rows[29];
    expect([
      page.items.length,
      page.items.map((item) => item.wantsToRelease).slice(9, 11),
      page.totalCount,
      page.artistCount,
      page.nextCursor,
    ]).toEqual([
      30,
      [true, false],
      45,
      10,
      thirtiethRow
        ? encodeAccessRequestCursor({
            wantsToRelease: thirtiethRow.wants_to_release,
            createdAt: thirtiethRow.created_at,
            id: thirtiethRow.id,
          })
        : 'missing row',
    ]);
    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(profiles.find).toHaveBeenCalledWith({
      where: { userId: In(rows.slice(0, 30).map((row) => row.user_id)) },
    });

    query.mockClear();
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('COUNT(*)')
          ? [{ total_count: 45, artist_count: 10 }]
          : rows.slice(30),
      ),
    );
    const nextPage = await service.listWaiting(page.nextCursor ?? undefined);
    const resumeCursor = decodeAccessRequestCursor(
      page.nextCursor ?? undefined,
    );
    const pageCall = (query.mock.calls as unknown[][]).find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('LIMIT'),
    );
    expect(pageCall?.[1]).toEqual([
      resumeCursor?.wantsToRelease,
      resumeCursor?.createdAt,
      resumeCursor?.id,
      31,
    ]);
    expect([nextPage.items.length, nextPage.nextCursor]).toEqual([1, null]);
  });

  it('reads a malformed cursor as the first page', async () => {
    await service.listWaiting('not-a-cursor');
    const pageCall = (query.mock.calls as unknown[][]).find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('LIMIT'),
    );
    expect(pageCall?.[1]).toEqual([null, null, null, 31]);
  });

  it('shows the member through toMemberRef and an empty page with zero counts', async () => {
    const row = requestRow(1, true);
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('COUNT(*)')
          ? [{ total_count: 1, artist_count: 1 }]
          : [row],
      ),
    );
    const hiddenPhotoProfile: Partial<Profile> = {
      userId: row.user_id,
      slug: 'ana-silva',
      firstName: 'Ana',
      lastName: 'Silva',
      pronouns: null,
      avatarUrl: 'avatars/ana.jpg',
      photoVisible: false,
    };
    profiles.find.mockResolvedValue([hiddenPhotoProfile]);
    const page = await service.listWaiting(undefined);
    expect(page.items.map((item) => item.member)).toEqual([
      {
        id: row.user_id,
        slug: 'ana-silva',
        displayName: 'Ana Silva',
        avatarUrl: null,
      },
    ]);

    query.mockResolvedValue([]);
    profiles.find.mockClear();
    expect(await service.listWaiting(undefined)).toEqual({
      items: [],
      nextCursor: null,
      totalCount: 0,
      artistCount: 0,
    });
    expect(profiles.find).not.toHaveBeenCalled();
  });

  it('grants through the access service and answers studio_access_request_not_found for an unknown request', async () => {
    query.mockResolvedValueOnce([{ user_id: MEMBER_ID }]);
    expect(await service.grantRequest(STAFF_ID, REQUEST_ID)).toEqual(
      GRANT_RESPONSE,
    );
    expect(access.grant).toHaveBeenCalledWith(STAFF_ID, MEMBER_ID);

    access.grant.mockClear();
    query.mockResolvedValueOnce([]);
    expect(
      await errorCodeOf(service.grantRequest(STAFF_ID, REQUEST_ID)),
    ).toEqual([404, 'studio_access_request_not_found']);
    expect(
      await errorCodeOf(service.grantRequest(STAFF_ID, 'not-a-uuid')),
    ).toEqual([404, 'studio_access_request_not_found']);
    expect(access.grant).not.toHaveBeenCalled();
  });

  it('dismisses quietly and idempotently', async () => {
    await service.dismissRequest(REQUEST_ID);
    await service.dismissRequest(REQUEST_ID);
    await service.dismissRequest('not-a-uuid');
    expect(query.mock.calls).toEqual([
      ['DELETE FROM "studio_access_requests" WHERE "id" = $1', [REQUEST_ID]],
      ['DELETE FROM "studio_access_requests" WHERE "id" = $1', [REQUEST_ID]],
    ]);
    expect(access.grant).not.toHaveBeenCalled();
  });
});
