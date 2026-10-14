// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioListeningFields1832500000000 } from '../migrations/1832500000000-AddStudioListeningFields';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The Studio listening migration on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-listening-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = '71000000-0000-4000-8000-000000000001';
const PERSONA_ID = '72000000-0000-4000-8000-000000000001';
const RELEASE_ID = '73000000-0000-4000-8000-000000000001';
const TRACK_ID = '74000000-0000-4000-8000-000000000001';
const PEAKS = Array.from({ length: 200 }, (_unused, index) => index);
const LISTENING_COLUMNS = [
  'chapters',
  'loudness_lufs',
  'peak_db',
  'synced_lyrics',
  'waveform_peaks',
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
  'AddStudioListeningFields1832500000000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const listeningColumnsPresent = async (): Promise<string[]> => {
      const rows: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM information_schema.columns
          WHERE "table_name" = 'studio_tracks' AND "column_name" = ANY($1)
          ORDER BY "column_name"`,
        [LISTENING_COLUMNS],
      );
      return rows.map((row) => row.column_name);
    };

    const updateTrack = (
      assignments: string,
      parameters: unknown[],
    ): Promise<unknown> =>
      dataSource.query(
        `UPDATE "studio_tracks" SET ${assignments} WHERE "id" = $1`,
        [TRACK_ID, ...parameters],
      );

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
      // The five columns come from the migration under review, so drop what
      // `synchronize` built from the entity (its checks go with them) and
      // let the migration add them back.
      await dataSource.query(
        `ALTER TABLE "studio_tracks"
           DROP COLUMN "waveform_peaks",
           DROP COLUMN "loudness_lufs",
           DROP COLUMN "peak_db",
           DROP COLUMN "synced_lyrics",
           DROP COLUMN "chapters"`,
      );

      await dataSource.getRepository(User).insert({
        id: OWNER_USER,
        googleId: `google-${OWNER_USER}`,
        email: `${OWNER_USER}@example.test`,
        status: UserStatus.Active,
      });
      await dataSource.getRepository(Subprofile).insert({
        id: PERSONA_ID,
        userId: OWNER_USER,
        slug: 'night-shift',
        displayName: 'Night Shift',
        kind: SubprofileKind.Dj,
      });
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type")
         VALUES ($1, $2, 'Lisbon at four', 'mix')`,
        [RELEASE_ID, PERSONA_ID],
      );
      // Written before the migration, so it stands for a track uploaded
      // before listening fields existed.
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "duration_seconds")
         VALUES ($1, $2, 1, 'Opening', 3600)`,
        [TRACK_ID, RELEASE_ID],
      );

      queryRunner = dataSource.createQueryRunner();
      await new AddStudioListeningFields1832500000000().up(queryRunner);
    }, 120000);

    afterEach(async () => {
      await updateTrack(
        `"waveform_peaks" = NULL, "loudness_lufs" = NULL, "peak_db" = NULL,
         "synced_lyrics" = NULL, "chapters" = NULL`,
        [],
      );
    });

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('adds five nullable columns and reads an existing track as unmeasured', async () => {
      expect(await listeningColumnsPresent()).toEqual(LISTENING_COLUMNS);
      const rows: Record<string, unknown>[] = await dataSource.query(
        `SELECT "waveform_peaks", "loudness_lufs", "peak_db", "synced_lyrics", "chapters"
           FROM "studio_tracks" WHERE "id" = $1`,
        [TRACK_ID],
      );
      expect(rows).toEqual([
        {
          waveform_peaks: null,
          loudness_lufs: null,
          peak_db: null,
          synced_lyrics: null,
          chapters: null,
        },
      ]);
    });

    it('reads the loudness pair back as numbers and the peaks as integers through the entity', async () => {
      await updateTrack(
        `"waveform_peaks" = $2, "loudness_lufs" = $3, "peak_db" = $4`,
        [PEAKS, -7.8, -0.1],
      );
      const track = await dataSource
        .getRepository(StudioTrack)
        .findOneByOrFail({ id: TRACK_ID });
      expect(track.loudnessLufs).toBe(-7.8);
      expect(track.peakDb).toBe(-0.1);
      expect(track.waveformPeaks).toEqual(PEAKS);
      expect(typeof track.waveformPeaks?.[0]).toBe('number');
    });

    it('stores timed lyrics and chapters as written through the entity', async () => {
      const syncedLyrics = [
        { ms: 0, text: 'First line' },
        { ms: 4000, text: '' },
      ];
      const chapters = [
        { startSeconds: 0, title: 'Intro', artist: null },
        { startSeconds: 95, title: 'Second', artist: 'Ana Moura' },
      ];
      await dataSource
        .getRepository(StudioTrack)
        .update(TRACK_ID, { syncedLyrics, chapters });
      const track = await dataSource
        .getRepository(StudioTrack)
        .findOneByOrFail({ id: TRACK_ID });
      expect(track.syncedLyrics).toEqual(syncedLyrics);
      expect(track.chapters).toEqual(chapters);
    });

    it.each([
      [
        '199 peaks',
        `"waveform_peaks" = $2`,
        [PEAKS.slice(1)],
        'CHK_studio_tracks_waveform_peaks',
      ],
      [
        'a peak of 256',
        `"waveform_peaks" = $2`,
        [[...PEAKS.slice(1), 256]],
        'CHK_studio_tracks_waveform_peaks',
      ],
      [
        'a null peak',
        `"waveform_peaks" = $2`,
        [[...PEAKS.slice(1), null]],
        'CHK_studio_tracks_waveform_peaks',
      ],
      [
        'a loudness without a peak',
        `"loudness_lufs" = $2`,
        [-14],
        'CHK_studio_tracks_loudness_pair',
      ],
      [
        'a loudness above 0',
        `"loudness_lufs" = $2, "peak_db" = $3`,
        [0.1, -1],
        'CHK_studio_tracks_loudness_lufs',
      ],
      [
        'a peak above 3',
        `"loudness_lufs" = $2, "peak_db" = $3`,
        [-14, 3.1],
        'CHK_studio_tracks_peak_db',
      ],
      [
        'empty timed lyrics',
        `"synced_lyrics" = $2::jsonb`,
        ['[]'],
        'CHK_studio_tracks_synced_lyrics',
      ],
      [
        'timed lyrics stored as an object',
        `"synced_lyrics" = $2::jsonb`,
        ['{"ms":0,"text":"First line"}'],
        'CHK_studio_tracks_synced_lyrics',
      ],
      [
        '101 chapters',
        `"chapters" = $2::jsonb`,
        [
          JSON.stringify(
            Array.from({ length: 101 }, (_unused, index) => ({
              startSeconds: index,
              title: `Part ${index + 1}`,
              artist: null,
            })),
          ),
        ],
        'CHK_studio_tracks_chapters',
      ],
    ])('refuses %s', async (_label, assignments, parameters, constraint) => {
      await expect(updateTrack(assignments, parameters)).rejects.toThrow(
        new RegExp(constraint),
      );
    });

    it('drops the five columns on down and adds them again on up', async () => {
      await new AddStudioListeningFields1832500000000().down(queryRunner);
      expect(await listeningColumnsPresent()).toEqual([]);
      await new AddStudioListeningFields1832500000000().up(queryRunner);
      expect(await listeningColumnsPresent()).toEqual(LISTENING_COLUMNS);
    });
  },
);
