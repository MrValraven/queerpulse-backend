// Lives in `src/database` beside the other Postgres specs.
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Report } from '../reports/entities/report.entity';
import { StudioAccessGrant } from '../studio/entities/studio-access-grant.entity';
import { StudioAccessRequestsService } from '../studio/studio-access-requests.service';
import { StudioAccessService } from '../studio/studio-access.service';
import { STUDIO_LIMITS } from '../studio/studio.constants';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio access requests (contract 12) on real Postgres: the grant deletes
 * the waiting request (contract 12.4) and the Waiting for Studio keyset pages
 * without a gap or a repeat. Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL`
 * names a database whose name ends in `_test` (it drops and synchronizes the
 * schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const STAFF_ID = 'fb000000-0000-4000-8000-000000000001';
const SUSPENDED_MEMBER_ID = 'fb000000-0000-4000-8000-000000000002';
const SAME_MILLISECOND = new Date('2026-10-28T09:00:00.123Z');
const MEMBER_COUNT = STUDIO_LIMITS.accessRequestsPageSize + 1;

function memberId(index: number): string {
  return `fb100000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio access requests on real Postgres', () => {
  let dataSource: DataSource;
  let emit: jest.Mock;
  let accessService: StudioAccessService;
  let requestsService: StudioAccessRequestsService;

  const insertRequest = async (
    userId: string,
    wantsToRelease: boolean,
    createdAt: Date,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO "studio_access_requests" ("user_id", "wants_to_release", "created_at")
       VALUES ($1, $2, $3)`,
      [userId, wantsToRelease, createdAt],
    );
  };

  const waitingUserIds = async (): Promise<string[]> => {
    const rows: { user_id: string }[] = await dataSource.query(
      `SELECT "user_id" FROM "studio_access_requests" ORDER BY "user_id"`,
    );
    return rows.map((row) => row.user_id);
  };

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [`${__dirname}/../**/*.entity.ts`],
      namingStrategy: new SnakeNamingStrategy(),
      dropSchema: true,
      synchronize: true,
    });
    await dataSource.initialize();
    const userIds = [
      STAFF_ID,
      ...Array.from({ length: MEMBER_COUNT }, (_unused, index) =>
        memberId(index + 1),
      ),
    ];
    await dataSource.getRepository(User).insert([
      ...userIds.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
      {
        id: SUSPENDED_MEMBER_ID,
        googleId: `google-${SUSPENDED_MEMBER_ID}`,
        email: `${SUSPENDED_MEMBER_ID}@example.test`,
        status: UserStatus.Suspended,
      },
    ]);
    await dataSource.getRepository(Profile).insert({
      userId: memberId(1),
      slug: 'ana-silva',
      firstName: 'Ana',
      lastName: 'Silva',
    });
    emit = jest.fn();
    const modAudit = new ModAuditService(
      dataSource.getRepository(ModAuditLog),
      dataSource.getRepository(Report),
      dataSource.getRepository(Profile),
      dataSource.getRepository(User),
    );
    accessService = new StudioAccessService(
      dataSource.getRepository(StudioAccessGrant),
      dataSource.getRepository(User),
      modAudit,
      { emit } as unknown as EventEmitter2,
    );
    requestsService = new StudioAccessRequestsService(
      dataSource,
      dataSource.getRepository(Profile),
      accessService,
    );
  }, 120000);

  afterEach(async () => {
    emit.mockClear();
    await dataSource.query(`DELETE FROM "studio_access_requests"`);
    await dataSource.query(`DELETE FROM "studio_access_grants"`);
    await dataSource.query(`DELETE FROM "mod_audit_logs"`);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('grants from the member drawer and deletes the waiting request', async () => {
    await insertRequest(memberId(1), true, SAME_MILLISECOND);
    await insertRequest(memberId(2), false, SAME_MILLISECOND);

    await accessService.grant(STAFF_ID, memberId(1));
    expect(await waitingUserIds()).toEqual([memberId(2)]);

    await insertRequest(memberId(1), false, SAME_MILLISECOND);
    await accessService.grant(STAFF_ID, memberId(1));
    expect(await waitingUserIds()).toEqual([memberId(2)]);

    expect(emit.mock.calls).toEqual([
      ['studio.access.granted', { userId: memberId(1) }],
    ]);
  });

  it('grants from the waiting list and answers not found once the request is gone', async () => {
    await insertRequest(memberId(1), true, SAME_MILLISECOND);
    const page = await requestsService.listWaiting(undefined);
    const requestId = page.items.at(0)?.id ?? 'missing';

    const grant = await requestsService.grantRequest(STAFF_ID, requestId);

    expect([grant.userId, await waitingUserIds()]).toEqual([memberId(1), []]);
    await expect(
      requestsService.grantRequest(STAFF_ID, requestId),
    ).rejects.toMatchObject({
      response: { code: 'studio_access_request_not_found' },
    });
  });

  it('pages two requests created in one millisecond without a gap or repeat', async () => {
    for (let index = 1; index <= MEMBER_COUNT; index += 1) {
      await insertRequest(memberId(index), false, SAME_MILLISECOND);
    }

    const firstPage = await requestsService.listWaiting(undefined);
    const secondPage = await requestsService.listWaiting(
      firstPage.nextCursor ?? undefined,
    );

    const firstIds = firstPage.items.map((item) => item.id);
    const secondIds = secondPage.items.map((item) => item.id);
    const allIds = [...firstIds, ...secondIds];
    expect([
      firstIds.length,
      secondIds.length,
      new Set(allIds).size,
      secondPage.nextCursor,
      [...allIds].sort(),
    ]).toEqual([
      STUDIO_LIMITS.accessRequestsPageSize,
      1,
      MEMBER_COUNT,
      null,
      allIds,
    ]);
  });

  it('leaves out inactive members and members who already hold a grant', async () => {
    await insertRequest(memberId(1), false, SAME_MILLISECOND);
    await insertRequest(memberId(2), true, SAME_MILLISECOND);
    await insertRequest(SUSPENDED_MEMBER_ID, true, SAME_MILLISECOND);
    await dataSource
      .getRepository(StudioAccessGrant)
      .insert({ userId: memberId(2), grantedById: STAFF_ID });

    const page = await requestsService.listWaiting(undefined);

    expect([
      page.items.map((item) => item.member.id),
      page.totalCount,
      page.artistCount,
    ]).toEqual([[memberId(1)], 1, 0]);
  });

  it('counts every waiting request and the artists among them', async () => {
    await insertRequest(memberId(1), false, new Date('2026-10-20T09:00:00Z'));
    await insertRequest(memberId(2), true, new Date('2026-10-22T09:00:00Z'));
    await insertRequest(memberId(3), true, new Date('2026-10-21T09:00:00Z'));

    const page = await requestsService.listWaiting(undefined);

    expect([
      page.items.map((item) => [item.member.id, item.wantsToRelease]),
      page.items.at(-1)?.member,
      page.totalCount,
      page.artistCount,
      page.nextCursor,
    ]).toEqual([
      [
        [memberId(3), true],
        [memberId(2), true],
        [memberId(1), false],
      ],
      {
        id: memberId(1),
        slug: 'ana-silva',
        displayName: 'Ana Silva',
        avatarUrl: null,
      },
      3,
      2,
      null,
    ]);
  });

  it('refuses a request from a member who holds a grant and a repeat request', async () => {
    await dataSource
      .getRepository(StudioAccessGrant)
      .insert({ userId: memberId(1), grantedById: STAFF_ID });

    await expect(
      requestsService.requestAccess(memberId(1), true),
    ).rejects.toMatchObject({
      response: { code: 'studio_access_already_granted' },
    });

    const state = await requestsService.requestAccess(memberId(2), true);
    expect(state.hasPendingRequest).toBe(true);
    await expect(
      requestsService.requestAccess(memberId(2), false),
    ).rejects.toMatchObject({
      response: { code: 'studio_access_request_exists' },
    });
    expect(await requestsService.findOwnRequest(memberId(2))).toEqual({
      wantsToRelease: true,
      requestedAt: state.requestedAt,
    });
  });
});
