// Lives in `src/database` beside the other Postgres specs.
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StudioRelease } from '../studio/entities/studio-release.entity';
import { StudioLandingPreviewsService } from '../studio/studio-landing-previews.service';
import { StudioOwnershipService } from '../studio/studio-ownership.service';
import { STUDIO_LANDING_PREVIEW_APPROVED } from '../studio/studio.events';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The owner approvals of the Studio landing previews on real Postgres
 * (contract 9.3 and 10). Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL`
 * names a database whose name ends in `_test` (it drops and synchronizes the
 * schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_A = 'c1000000-0000-4000-8000-000000000001';
const OWNER_B = 'c1000000-0000-4000-8000-000000000002';
const CREDITED_OWNER = 'c1000000-0000-4000-8000-000000000003';
const PENDING_CREDIT_OWNER = 'c1000000-0000-4000-8000-000000000004';
const USERS = [OWNER_A, OWNER_B, CREDITED_OWNER, PENDING_CREDIT_OWNER];

const PERSONA_ID = 'c2000000-0000-4000-8000-000000000001';
const CREDITED_PERSONA = 'c2000000-0000-4000-8000-000000000002';
const PENDING_CREDIT_PERSONA = 'c2000000-0000-4000-8000-000000000003';

const MAIN_RELEASE = 'c3000000-0000-4000-8000-000000000001';
const CREDITED_PERSONA_RELEASE = 'c3000000-0000-4000-8000-000000000002';

const PENDING_TRACK = 'c4000000-0000-4000-8000-000000000001';
const CREDITED_TRACK = 'c4000000-0000-4000-8000-000000000002';
const DECLINED_TRACK = 'c4000000-0000-4000-8000-000000000003';
const OWN_TRACK_OF_CREDITED = 'c4000000-0000-4000-8000-000000000004';

const PREVIEW_ID = 'c5000000-0000-4000-8000-000000000001';
const APPROVED_CREDITED_PREVIEW = 'c5000000-0000-4000-8000-000000000002';
const DECLINED_PREVIEW = 'c5000000-0000-4000-8000-000000000003';
const CREDITED_PERSONA_OWN_PREVIEW = 'c5000000-0000-4000-8000-000000000004';

interface PreviewFixture {
  id: string;
  trackId: string;
  status: string;
  position: number;
  createdAt: string;
  decidedAt: string | null;
}

const PREVIEWS: PreviewFixture[] = [
  {
    id: PREVIEW_ID,
    trackId: PENDING_TRACK,
    status: 'pending',
    position: 1,
    createdAt: '2026-10-20T10:00:00.000Z',
    decidedAt: null,
  },
  {
    id: APPROVED_CREDITED_PREVIEW,
    trackId: CREDITED_TRACK,
    status: 'approved',
    position: 2,
    createdAt: '2026-10-18T10:00:00.000Z',
    decidedAt: '2026-10-19T10:00:00.000Z',
  },
  {
    id: DECLINED_PREVIEW,
    trackId: DECLINED_TRACK,
    status: 'declined',
    position: 3,
    createdAt: '2026-10-17T10:00:00.000Z',
    decidedAt: '2026-10-18T10:00:00.000Z',
  },
  {
    id: CREDITED_PERSONA_OWN_PREVIEW,
    trackId: OWN_TRACK_OF_CREDITED,
    status: 'approved',
    position: 4,
    createdAt: '2026-10-16T10:00:00.000Z',
    decidedAt: '2026-10-21T10:00:00.000Z',
  },
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase(
  'Studio landing preview approvals on real Postgres',
  () => {
    let dataSource: DataSource;
    let eventEmitter: EventEmitter2;
    let emitSpy: jest.SpyInstance;
    let service: StudioLandingPreviewsService;

    const statusOf = async (previewId: string): Promise<string | null> => {
      const rows: { status: string }[] = await dataSource.query(
        `SELECT "status"::text AS "status" FROM "studio_landing_previews" WHERE "id" = $1`,
        [previewId],
      );
      return rows.map((row) => row.status).find(() => true) ?? null;
    };

    const listed = async (
      viewerId: string,
      subprofileId: string,
    ): Promise<[string, string, string][]> =>
      (await service.listForPersona(viewerId, subprofileId)).items.map(
        (item): [string, string, string] => [
          item.id,
          item.status,
          item.relation,
        ],
      );

    const withCredit = async (
      trackId: string,
      subprofileId: string,
      status: 'pending' | 'accepted',
      check: () => Promise<void>,
    ): Promise<void> => {
      await dataSource.query(
        `INSERT INTO "studio_persona_credits"
         ("track_id", "subprofile_id", "role", "status", "requested_by_subprofile_id")
       VALUES ($1, $2, 'vocals', $3, $4)`,
        [trackId, subprofileId, status, PERSONA_ID],
      );
      try {
        await check();
      } finally {
        await dataSource.query(
          `DELETE FROM "studio_persona_credits" WHERE "track_id" = $1 AND "subprofile_id" = $2 AND "role" = 'vocals'`,
          [trackId, subprofileId],
        );
      }
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

      await dataSource.getRepository(User).insert(
        USERS.map((userId) => ({
          id: userId,
          googleId: `google-${userId}`,
          email: `${userId}@example.test`,
          status: UserStatus.Active,
        })),
      );
      await dataSource.getRepository(Subprofile).insert([
        {
          id: PERSONA_ID,
          userId: OWNER_A,
          slug: 'harbour-lights',
          handle: 'harbour-lights',
          displayName: 'Harbour Lights',
          kind: SubprofileKind.Musician,
          status: SubprofileStatus.Published,
          visibility: SubprofileVisibility.Open,
        },
        {
          id: CREDITED_PERSONA,
          userId: CREDITED_OWNER,
          slug: 'tram-28',
          handle: 'tram-28',
          displayName: 'Tram 28',
          kind: SubprofileKind.Dj,
          status: SubprofileStatus.Published,
          visibility: SubprofileVisibility.Open,
        },
        {
          id: PENDING_CREDIT_PERSONA,
          userId: PENDING_CREDIT_OWNER,
          slug: 'paper-lanterns',
          handle: 'paper-lanterns',
          displayName: 'Paper Lanterns',
          kind: SubprofileKind.Performer,
          status: SubprofileStatus.Published,
          visibility: SubprofileVisibility.Open,
        },
      ]);
      await dataSource.getRepository(SubprofileMember).insert([
        { subprofileId: PERSONA_ID, userId: OWNER_A },
        { subprofileId: PERSONA_ID, userId: OWNER_B },
        { subprofileId: CREDITED_PERSONA, userId: CREDITED_OWNER },
        { subprofileId: PENDING_CREDIT_PERSONA, userId: PENDING_CREDIT_OWNER },
      ]);
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now()),
              ($3, $4, 'Tram at dawn', 'mix', 'published', now())`,
        [MAIN_RELEASE, PERSONA_ID, CREDITED_PERSONA_RELEASE, CREDITED_PERSONA],
      );
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $5, 1, 'Harbour', 'studio-audio/a/b.mp3', 200),
              ($2, $5, 2, 'Lights', 'studio-audio/a/c.mp3', 200),
              ($3, $5, 3, 'Undertow', 'studio-audio/a/d.mp3', 200),
              ($4, $6, 1, 'Tram solo', 'studio-audio/a/e.mp3', 200)`,
        [
          PENDING_TRACK,
          CREDITED_TRACK,
          DECLINED_TRACK,
          OWN_TRACK_OF_CREDITED,
          MAIN_RELEASE,
          CREDITED_PERSONA_RELEASE,
        ],
      );
      // The credited persona holds an accepted credit on the pending track too,
      // so the list shows that a pending row belongs to the release persona alone.
      await dataSource.query(
        `INSERT INTO "studio_persona_credits"
         ("track_id", "subprofile_id", "role", "status", "requested_by_subprofile_id")
       VALUES ($1, $3, 'producer', 'accepted', $4),
              ($2, $3, 'producer', 'accepted', $4)`,
        [PENDING_TRACK, CREDITED_TRACK, CREDITED_PERSONA, PERSONA_ID],
      );

      const ownership = new StudioOwnershipService(
        dataSource.getRepository(SubprofileMember),
        dataSource.getRepository(Subprofile),
        dataSource.getRepository(StudioRelease),
      );
      eventEmitter = new EventEmitter2();
      service = new StudioLandingPreviewsService(
        dataSource,
        ownership,
        eventEmitter,
      );
    });

    beforeEach(async () => {
      emitSpy = jest.spyOn(eventEmitter, 'emit');
      await dataSource.query(`DELETE FROM "studio_landing_previews"`);
      for (const preview of PREVIEWS) {
        await dataSource.query(
          `INSERT INTO "studio_landing_previews"
           ("id", "track_id", "status", "position", "created_at", "decided_at")
         VALUES ($1, $2, $3::"studio_landing_previews_status_enum", $4, $5::timestamptz, $6::timestamptz)`,
          [
            preview.id,
            preview.trackId,
            preview.status,
            preview.position,
            preview.createdAt,
            preview.decidedAt,
          ],
        );
      }
    });

    afterEach(() => {
      emitSpy.mockRestore();
    });

    afterAll(async () => {
      await dataSource?.destroy();
    });

    it('lets the first of two owners approving at once win and the second read 409', async () => {
      const outcomes = await Promise.allSettled([
        service.approve(OWNER_A, PERSONA_ID, PREVIEW_ID),
        service.approve(OWNER_B, PERSONA_ID, PREVIEW_ID),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(
        outcomes
          .filter(
            (outcome): outcome is PromiseRejectedResult =>
              outcome.status === 'rejected',
          )
          .map((outcome) => outcome.reason as unknown),
      ).toEqual([
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'studio_landing_preview_not_pending',
          }) as unknown,
        }),
      ]);
      expect(await statusOf(PREVIEW_ID)).toBe('approved');
      expect(
        emitSpy.mock.calls.filter(
          ([eventName]) => eventName === STUDIO_LANDING_PREVIEW_APPROVED,
        ),
      ).toHaveLength(1);
    });

    it('lets a decline and an approval at once decide the row once', async () => {
      const outcomes = await Promise.allSettled([
        service.decline(OWNER_A, PERSONA_ID, PREVIEW_ID),
        service.approve(OWNER_B, PERSONA_ID, PREVIEW_ID),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const status = await statusOf(PREVIEW_ID);
      expect(['approved', 'declined']).toContain(status);
      expect(
        emitSpy.mock.calls.filter(
          ([eventName]) => eventName === STUDIO_LANDING_PREVIEW_APPROVED,
        ),
      ).toHaveLength(status === 'approved' ? 1 : 0);
    });

    it('stores the decider and answers no member field', async () => {
      const approved = await service.approve(OWNER_B, PERSONA_ID, PREVIEW_ID);
      expect(approved.status).toBe('approved');
      expect(JSON.stringify(approved)).not.toContain(OWNER_B);
      const rows: { decided_by_id: string | null; has_decided_at: boolean }[] =
        await dataSource.query(
          `SELECT "decided_by_id", "decided_at" IS NOT NULL AS "has_decided_at"
           FROM "studio_landing_previews" WHERE "id" = $1`,
          [PREVIEW_ID],
        );
      expect(rows).toEqual([{ decided_by_id: OWNER_B, has_decided_at: true }]);
    });

    it('lists pending rows for the main persona only and approved rows for main and credited personas', async () => {
      expect(await listed(OWNER_A, PERSONA_ID)).toEqual([
        [PREVIEW_ID, 'pending', 'main'],
        [APPROVED_CREDITED_PREVIEW, 'approved', 'main'],
      ]);
      // Approved rows by decision time, newest first; the pending track the
      // credited persona also holds a credit on stays off its list.
      expect(await listed(CREDITED_OWNER, CREDITED_PERSONA)).toEqual([
        [CREDITED_PERSONA_OWN_PREVIEW, 'approved', 'main'],
        [APPROVED_CREDITED_PREVIEW, 'approved', 'credited'],
      ]);
    });

    it('refuses approve from a credited persona and lets it withdraw', async () => {
      await expect(
        service.approve(CREDITED_OWNER, CREDITED_PERSONA, PREVIEW_ID),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_preview_main_persona_only' },
      });
      expect(await statusOf(PREVIEW_ID)).toBe('pending');
      const withdrawn = await service.withdraw(
        CREDITED_OWNER,
        CREDITED_PERSONA,
        APPROVED_CREDITED_PREVIEW,
      );
      expect(withdrawn).toMatchObject({
        status: 'withdrawn',
        relation: 'credited',
      });
      expect(await statusOf(APPROVED_CREDITED_PREVIEW)).toBe('withdrawn');
      await expect(
        service.withdraw(
          CREDITED_OWNER,
          CREDITED_PERSONA,
          APPROVED_CREDITED_PREVIEW,
        ),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_preview_not_approved' },
      });
    });

    it('answers not_pending on a declined row', async () => {
      await expect(
        service.approve(OWNER_A, PERSONA_ID, DECLINED_PREVIEW),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_preview_not_pending' },
      });
      expect(await statusOf(DECLINED_PREVIEW)).toBe('declined');
    });

    it('answers Artist not found to a member of another persona', async () => {
      await expect(
        service.listForPersona(CREDITED_OWNER, PERSONA_ID),
      ).rejects.toMatchObject({ message: 'Artist not found' });
    });

    it('reads a persona that is both main and credited as main', async () => {
      await withCredit(CREDITED_TRACK, PERSONA_ID, 'accepted', async () => {
        expect(await listed(OWNER_A, PERSONA_ID)).toEqual([
          [PREVIEW_ID, 'pending', 'main'],
          [APPROVED_CREDITED_PREVIEW, 'approved', 'main'],
        ]);
      });
    });

    it('leaves out a credit that is still pending', async () => {
      await withCredit(
        CREDITED_TRACK,
        PENDING_CREDIT_PERSONA,
        'pending',
        async () => {
          expect(
            await listed(PENDING_CREDIT_OWNER, PENDING_CREDIT_PERSONA),
          ).toEqual([]);
          await expect(
            service.withdraw(
              PENDING_CREDIT_OWNER,
              PENDING_CREDIT_PERSONA,
              APPROVED_CREDITED_PREVIEW,
            ),
          ).rejects.toMatchObject({
            response: { code: 'studio_landing_preview_not_found' },
          });
        },
      );
    });
  },
);
