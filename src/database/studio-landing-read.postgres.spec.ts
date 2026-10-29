// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { StorageService } from '../storage/storage.service';
import {
  LANDING_COUNTS_SQL,
  LANDING_PREVIEWS_SQL,
  StudioLandingReadService,
} from '../studio/studio-landing-read.service';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The public Studio page read and its preview stream (contract 2 and 3) on
 * real Postgres. Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL` names a
 * database whose name ends in `_test` (it drops and synchronizes the schema
 * from the entities):
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-landing-read.postgres.spec.ts
 *
 * The cast:
 * - ACTIVE_OWNER runs five musician personas and a podcast show, each with
 *   one published release, and hosts every event the musicians play.
 * - SUSPENDED_OWNER runs one musician persona with a published release.
 * - OTHER_HOST hosts one event a musician lists without standing in it, and
 *   files the copyright claim.
 * - Each persona's first track holds an approved preview; three more tracks
 *   of MUSICIAN_ONE hold a pending, a declined and a withdrawn one.
 *
 * Every test that changes a row puts it back before it ends.
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const API_BASE = 'https://api.example.test';
const SIGNED_URL = 'https://bucket.example.test/signed-preview';
const EXPIRES_AT = '2026-10-28T10:15:00.000Z';
const TIME_ZONE = 'Europe/Lisbon';

const ACTIVE_OWNER = 'e8000000-0000-4000-8000-000000000001';
const SUSPENDED_OWNER = 'e8000000-0000-4000-8000-000000000002';
const OTHER_HOST = 'e8000000-0000-4000-8000-000000000003';

const MUSICIAN_ONE = 'e8100000-0000-4000-8000-000000000001';
const MUSICIAN_TWO = 'e8100000-0000-4000-8000-000000000002';
const MUSICIAN_THREE = 'e8100000-0000-4000-8000-000000000003';
const MUSICIAN_FOUR = 'e8100000-0000-4000-8000-000000000004';
const MUSICIAN_FIVE = 'e8100000-0000-4000-8000-000000000005';
const PODCAST_SHOW = 'e8100000-0000-4000-8000-000000000006';
const SUSPENDED_ARTIST = 'e8100000-0000-4000-8000-000000000007';

/** One release and one first track per persona, same suffix. */
const releaseOf = (personaId: string): string => `e82${personaId.slice(3)}`;
const firstTrackOf = (personaId: string): string => `e83${personaId.slice(3)}`;
const previewOf = (trackId: string): string => `e84${trackId.slice(3)}`;

const PENDING_TRACK = 'e8300000-0000-4000-8000-000000000101';
const DECLINED_TRACK = 'e8300000-0000-4000-8000-000000000102';
const WITHDRAWN_TRACK = 'e8300000-0000-4000-8000-000000000103';

const EVENT_PAST_THIS_MONTH = 'e8500000-0000-4000-8000-000000000001';
const EVENT_NEXT_MONTH = 'e8500000-0000-4000-8000-000000000002';
const EVENT_MEMBERS_SOON = 'e8500000-0000-4000-8000-000000000003';
const EVENT_NOT_STANDING = 'e8500000-0000-4000-8000-000000000004';
const EVENT_PUBLIC_NEXT = 'e8500000-0000-4000-8000-000000000005';

/** Member-scoped avatar keys: the middle segment names ACTIVE_OWNER. */
const LINKED_AVATAR_KEY = `avatars/${ACTIVE_OWNER}/e8600000-0000-4000-8000-000000000001.jpg`;
const UNLINKED_AVATAR_KEY = `avatars/${ACTIVE_OWNER}/e8600000-0000-4000-8000-000000000002.jpg`;

const EVERY_PERSONA: Partial<Subprofile>[] = [
  {
    id: MUSICIAN_ONE,
    userId: ACTIVE_OWNER,
    handle: 'musician-one',
    displayName: 'Musician one',
    kind: SubprofileKind.Musician,
    avatarUrl: LINKED_AVATAR_KEY,
    linkVisibility: SubprofileLinkVisibility.Linked,
  },
  {
    id: MUSICIAN_TWO,
    userId: ACTIVE_OWNER,
    handle: 'musician-two',
    displayName: 'Musician two',
    kind: SubprofileKind.Musician,
    avatarUrl: UNLINKED_AVATAR_KEY,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
  },
  {
    id: MUSICIAN_THREE,
    userId: ACTIVE_OWNER,
    handle: 'musician-three',
    displayName: 'Musician three',
    kind: SubprofileKind.Musician,
  },
  {
    id: MUSICIAN_FOUR,
    userId: ACTIVE_OWNER,
    handle: 'musician-four',
    displayName: 'Musician four',
    kind: SubprofileKind.Musician,
  },
  {
    id: MUSICIAN_FIVE,
    userId: ACTIVE_OWNER,
    handle: 'musician-five',
    displayName: 'Musician five',
    kind: SubprofileKind.Musician,
  },
  {
    id: PODCAST_SHOW,
    userId: ACTIVE_OWNER,
    handle: 'podcast-show',
    displayName: 'Podcast show',
    kind: SubprofileKind.Podcaster,
  },
  {
    id: SUSPENDED_ARTIST,
    userId: SUSPENDED_OWNER,
    handle: 'suspended-artist',
    displayName: 'Suspended artist',
    kind: SubprofileKind.Musician,
  },
];

const handleOf = (personaId: string): string =>
  EVERY_PERSONA.find((persona) => persona.id === personaId)?.handle ?? '';

/** Every first track is titled after its persona's handle. */
const firstTrackTitleOf = (personaId: string): string =>
  `${handleOf(personaId)} opening`;

const MUSICIAN_TITLES = [
  MUSICIAN_ONE,
  MUSICIAN_TWO,
  MUSICIAN_THREE,
  MUSICIAN_FOUR,
  MUSICIAN_FIVE,
].map(firstTrackTitleOf);

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio landing public read on real Postgres', () => {
  let dataSource: DataSource;
  let storage: { createPresignedAudioStream: jest.Mock };

  /** A fresh service per read, so no memo carries over between steps. */
  const freshService = (): StudioLandingReadService =>
    new StudioLandingReadService(
      dataSource,
      storage as unknown as StorageService,
    );

  /** Every eligible approved preview, by track title, under a wide limit. */
  const previewTitles = async (): Promise<string[]> => {
    const rows: { track_title: string }[] = await dataSource.query(
      LANDING_PREVIEWS_SQL,
      [50],
    );
    return rows.map((row) => row.track_title);
  };

  const eventsThisMonth = async (): Promise<number> => {
    const rows: { events_this_month: number }[] = await dataSource.query(
      LANDING_COUNTS_SQL,
      [TIME_ZONE],
    );
    return rows[0]?.events_this_month ?? -1;
  };

  const previewStatusOf = async (trackId: string): Promise<string | null> => {
    const rows: { status: string }[] = await dataSource.query(
      `SELECT "status"::text AS "status" FROM "studio_landing_previews" WHERE "track_id" = $1`,
      [trackId],
    );
    return rows[0]?.status ?? null;
  };

  const setTrackColumn = (
    trackId: string,
    assignmentSql: string,
  ): Promise<unknown> =>
    dataSource.query(
      `UPDATE "studio_tracks" SET ${assignmentSql} WHERE "id" = $1`,
      [trackId],
    );

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    setImageUrlBase(API_BASE);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [`${__dirname}/../**/*.entity.ts`],
      namingStrategy: new SnakeNamingStrategy(),
      dropSchema: true,
      synchronize: true,
    });
    await dataSource.initialize();

    const everyUser: [string, UserStatus][] = [
      [ACTIVE_OWNER, UserStatus.Active],
      [SUSPENDED_OWNER, UserStatus.Suspended],
      [OTHER_HOST, UserStatus.Active],
    ];
    await dataSource.getRepository(User).insert(
      everyUser.map(([userId, status]) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status,
      })),
    );
    await dataSource.getRepository(Subprofile).insert(
      EVERY_PERSONA.map((persona) => ({
        ...persona,
        slug: persona.handle ?? '',
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      })),
    );

    for (const persona of EVERY_PERSONA) {
      const personaId = persona.id ?? '';
      const isPodcast = personaId === PODCAST_SHOW;
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
         VALUES ($1, $2, $3, $4, 'published', now() - interval '1 day')`,
        [
          releaseOf(personaId),
          personaId,
          `Release of ${persona.handle}`,
          isPodcast ? 'podcast' : 'single',
        ],
      );
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "audio_content_type", "duration_seconds", "published_at")
         VALUES ($1, $2, 1, $3, $4, 'audio/mpeg', 210, now() - interval '1 day')`,
        [
          firstTrackOf(personaId),
          releaseOf(personaId),
          firstTrackTitleOf(personaId),
          `studio-audio/${ACTIVE_OWNER}/${firstTrackOf(personaId)}.mp3`,
        ],
      );
    }
    const extraTracks: [string, number, string][] = [
      [PENDING_TRACK, 2, 'Pending track'],
      [DECLINED_TRACK, 3, 'Declined track'],
      [WITHDRAWN_TRACK, 4, 'Withdrawn track'],
    ];
    for (const [trackId, position, title] of extraTracks) {
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "audio_content_type", "duration_seconds")
         VALUES ($1, $2, $3, $4, $5, 'audio/mpeg', 180)`,
        [
          trackId,
          releaseOf(MUSICIAN_ONE),
          position,
          title,
          `studio-audio/${ACTIVE_OWNER}/${trackId}.mp3`,
        ],
      );
    }

    const previews: [string, string, number][] = [
      ...EVERY_PERSONA.map((persona, index): [string, string, number] => [
        firstTrackOf(persona.id ?? ''),
        'approved',
        index + 1,
      ]),
      [PENDING_TRACK, 'pending', 8],
      [DECLINED_TRACK, 'declined', 9],
      [WITHDRAWN_TRACK, 'withdrawn', 10],
    ];
    for (const [trackId, status, position] of previews) {
      await dataSource.query(
        `INSERT INTO "studio_landing_previews" ("id", "track_id", "status", "position")
         VALUES ($1, $2, $3, $4)`,
        [previewOf(trackId), trackId, status, position],
      );
    }

    const monthStartSql = `(date_trunc('month', now() AT TIME ZONE '${TIME_ZONE}') AT TIME ZONE '${TIME_ZONE}')`;
    const nextMonthStartSql = `((date_trunc('month', now() AT TIME ZONE '${TIME_ZONE}') + interval '1 month') AT TIME ZONE '${TIME_ZONE}')`;
    const events: [string, string, string, string, string][] = [
      [
        EVENT_PAST_THIS_MONTH,
        'past-this-month',
        `${monthStartSql} + interval '1 minute'`,
        'public',
        ACTIVE_OWNER,
      ],
      [
        EVENT_NEXT_MONTH,
        'next-month-show',
        `${nextMonthStartSql} + interval '20 days'`,
        'public',
        ACTIVE_OWNER,
      ],
      [
        EVENT_MEMBERS_SOON,
        'members-soon',
        `now() + interval '2 hours'`,
        'members',
        ACTIVE_OWNER,
      ],
      [
        EVENT_NOT_STANDING,
        'not-standing',
        `now() + interval '3 hours'`,
        'public',
        OTHER_HOST,
      ],
      [
        EVENT_PUBLIC_NEXT,
        'public-next',
        `now() + interval '1 day'`,
        'public',
        ACTIVE_OWNER,
      ],
    ];
    for (const [eventId, slug, startAtSql, visibility, hostId] of events) {
      await dataSource.query(
        `INSERT INTO "events" ("id", "host_id", "slug", "title", "description", "start_at", "timezone", "status", "visibility", "neighbourhood", "is_online")
         VALUES ($1, $2, $3, $4, 'A night out', ${startAtSql}, $5, 'published', $6, 'Intendente', false)`,
        [eventId, hostId, slug, `Event ${slug}`, TIME_ZONE, visibility],
      );
    }
    // MUSICIAN_ONE performs at every event ACTIVE_OWNER hosts, so each link
    // stands; MUSICIAN_TWO lists the event OTHER_HOST runs and holds no
    // lineup entry there, so that link does not stand.
    const affiliations: [string, string][] = [
      [MUSICIAN_ONE, 'past-this-month'],
      [MUSICIAN_ONE, 'next-month-show'],
      [MUSICIAN_ONE, 'members-soon'],
      [MUSICIAN_ONE, 'public-next'],
      [MUSICIAN_TWO, 'not-standing'],
    ];
    for (const [personaId, slug] of affiliations) {
      await dataSource.query(
        `INSERT INTO "subprofile_affiliations" ("subprofile_id", "target_type", "target_slug", "role")
         VALUES ($1, 'event', $2, 'performing')`,
        [personaId, slug],
      );
    }

    // Cards: one, two and three in staff order, the suspended artist last;
    // three and five are founding artists, and five holds no card.
    const cards: [string, number][] = [
      [MUSICIAN_ONE, 1],
      [MUSICIAN_TWO, 2],
      [MUSICIAN_THREE, 3],
      [SUSPENDED_ARTIST, 4],
    ];
    for (const [personaId, position] of cards) {
      await dataSource.query(
        `INSERT INTO "studio_landing_artist_cards" ("subprofile_id", "quote", "position", "has_consent")
         VALUES ($1, $2, $3, true)`,
        [personaId, `Quote of ${handleOf(personaId)}`, position],
      );
    }
    await dataSource.query(
      `INSERT INTO "studio_founding_artists" ("subprofile_id", "position")
       VALUES ($1, 1), ($2, 2)`,
      [MUSICIAN_THREE, MUSICIAN_FIVE],
    );
  }, 120000);

  beforeEach(() => {
    storage = {
      createPresignedAudioStream: jest
        .fn()
        .mockResolvedValue({ url: SIGNED_URL, expiresAt: EXPIRES_AT }),
    };
  });

  afterAll(async () => {
    resetImageUrlBaseForTesting();
    await dataSource?.destroy();
  });

  it('lists the five approved musician previews in staff order', async () => {
    expect(await previewTitles()).toEqual(MUSICIAN_TITLES);
    const landing = await freshService().getPublicLanding();
    expect(landing.previews.map((preview) => preview.trackTitle)).toEqual(
      MUSICIAN_TITLES,
    );
  });

  it('leaves out a preview whose track gained a content warning, an open claim or the explicit tag', async () => {
    const trackId = firstTrackOf(MUSICIAN_FOUR);
    const title = firstTrackTitleOf(MUSICIAN_FOUR);

    await setTrackColumn(trackId, `"content_warnings" = ARRAY['violence']`);
    expect(await previewTitles()).not.toContain(title);
    await setTrackColumn(trackId, `"content_warnings" = '{}'`);

    await setTrackColumn(
      trackId,
      `"staff_content_warnings" = ARRAY['violence']`,
    );
    expect(await previewTitles()).not.toContain(title);
    await setTrackColumn(trackId, `"staff_content_warnings" = '{}'`);

    await setTrackColumn(trackId, `"is_explicit" = true`);
    expect(await previewTitles()).not.toContain(title);
    await setTrackColumn(trackId, `"is_explicit" = false`);

    await dataSource.query(
      `INSERT INTO "studio_copyright_claims"
         ("track_id", "release_id", "claimant_id", "claimant_role", "original_work", "details", "good_faith_at", "status", "track_title_at_filing", "artist_name_at_filing")
       VALUES ($1, $2, $3, 'rights_holder', 'Saudade', 'The hook', now(), 'submitted', $4, 'Musician four')`,
      [trackId, releaseOf(MUSICIAN_FOUR), OTHER_HOST, title],
    );
    expect(await previewTitles()).not.toContain(title);
    await dataSource.query(
      `DELETE FROM "studio_copyright_claims" WHERE "track_id" = $1`,
      [trackId],
    );

    expect(await previewTitles()).toContain(title);
    expect(await previewStatusOf(trackId)).toBe('approved');
  });

  it('leaves out a podcast episode and a track on a taken down release', async () => {
    expect(await previewTitles()).not.toContain(
      firstTrackTitleOf(PODCAST_SHOW),
    );

    await dataSource.query(
      `UPDATE "studio_releases"
          SET "status" = 'taken_down', "taken_down_at" = now(), "takedown_reason" = 'Uploaded without the rights'
        WHERE "id" = $1`,
      [releaseOf(MUSICIAN_FIVE)],
    );
    expect(await previewTitles()).not.toContain(
      firstTrackTitleOf(MUSICIAN_FIVE),
    );
    await dataSource.query(
      `UPDATE "studio_releases"
          SET "status" = 'published', "taken_down_at" = NULL, "takedown_reason" = NULL
        WHERE "id" = $1`,
      [releaseOf(MUSICIAN_FIVE)],
    );
    expect(await previewTitles()).toContain(firstTrackTitleOf(MUSICIAN_FIVE));
  });

  it('leaves out a pending, declined or withdrawn preview', async () => {
    const titles = await previewTitles();

    expect(titles).not.toContain('Pending track');
    expect(titles).not.toContain('Declined track');
    expect(titles).not.toContain('Withdrawn track');
    for (const trackId of [PENDING_TRACK, DECLINED_TRACK, WITHDRAWN_TRACK]) {
      await expect(
        freshService().getPreviewStream(previewOf(trackId)),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_preview_unavailable' },
      });
    }
  });

  it('leaves out a persona whose creator is suspended and one set to network', async () => {
    const suspendedTitle = firstTrackTitleOf(SUSPENDED_ARTIST);
    expect(await previewTitles()).not.toContain(suspendedTitle);
    await dataSource.query(`UPDATE "users" SET "status" = $2 WHERE "id" = $1`, [
      SUSPENDED_OWNER,
      UserStatus.Active,
    ]);
    expect(await previewTitles()).toContain(suspendedTitle);
    await dataSource.query(`UPDATE "users" SET "status" = $2 WHERE "id" = $1`, [
      SUSPENDED_OWNER,
      UserStatus.Suspended,
    ]);

    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'network' WHERE "id" = $1`,
      [MUSICIAN_THREE],
    );
    expect(await previewTitles()).not.toContain(
      firstTrackTitleOf(MUSICIAN_THREE),
    );
    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'open' WHERE "id" = $1`,
      [MUSICIAN_THREE],
    );
  });

  it('counts the live artists and their published releases, leaving out a suspended creator', async () => {
    const rows: { artists: number; releases: number }[] =
      await dataSource.query(LANDING_COUNTS_SQL, [TIME_ZONE]);

    expect(
      rows.map((row) => ({ artists: row.artists, releases: row.releases })),
    ).toEqual([{ artists: 6, releases: 6 }]);
  });

  it('counts past events of this month and leaves out next month', async () => {
    const baseline = await eventsThisMonth();
    const cancel = (eventId: string): Promise<unknown> =>
      dataSource.query(
        `UPDATE "events" SET "status" = 'cancelled' WHERE "id" = $1`,
        [eventId],
      );
    const republish = (eventId: string): Promise<unknown> =>
      dataSource.query(
        `UPDATE "events" SET "status" = 'published' WHERE "id" = $1`,
        [eventId],
      );

    await cancel(EVENT_PAST_THIS_MONTH);
    expect(await eventsThisMonth()).toBe(baseline - 1);
    await republish(EVENT_PAST_THIS_MONTH);

    await cancel(EVENT_NEXT_MONTH);
    expect(await eventsThisMonth()).toBe(baseline);
    await republish(EVENT_NEXT_MONTH);

    // The event OTHER_HOST runs carries no standing performer, so moving it
    // into the month window adds nothing.
    await dataSource.query(
      `UPDATE "events" SET "start_at" = (date_trunc('month', now() AT TIME ZONE '${TIME_ZONE}') AT TIME ZONE '${TIME_ZONE}') + interval '2 minutes'
        WHERE "id" = $1`,
      [EVENT_NOT_STANDING],
    );
    expect(await eventsThisMonth()).toBe(baseline);
    await dataSource.query(
      `UPDATE "events" SET "start_at" = now() + interval '3 hours' WHERE "id" = $1`,
      [EVENT_NOT_STANDING],
    );
  });

  it('shows the next public event with a standing performer and leaves out a members event', async () => {
    const landing = await freshService().getPublicLanding();
    expect(landing.nextEvent).toMatchObject({
      slug: 'public-next',
      title: 'Event public-next',
      timezone: TIME_ZONE,
      area: 'Intendente',
      isOnline: false,
      artist: {
        handle: 'musician-one',
        name: 'Musician one',
        kind: 'musician',
      },
    });

    await dataSource.query(
      `UPDATE "events" SET "visibility" = 'members' WHERE "id" = $1`,
      [EVENT_PUBLIC_NEXT],
    );
    const withoutPublicNext = await freshService().getPublicLanding();
    expect(withoutPublicNext.nextEvent?.slug).toBe('next-month-show');
    await dataSource.query(
      `UPDATE "events" SET "visibility" = 'public' WHERE "id" = $1`,
      [EVENT_PUBLIC_NEXT],
    );
  });

  it('leaves out the event of an unlinked persona its owner hosts', async () => {
    // MUSICIAN_ONE is the only standing performer at every public event
    // ACTIVE_OWNER hosts, so once it turns unlinked no event qualifies.
    const setLinkVisibility = (
      linkVisibility: SubprofileLinkVisibility,
    ): Promise<unknown> =>
      dataSource.query(
        `UPDATE "subprofiles" SET "link_visibility" = $2 WHERE "id" = $1`,
        [MUSICIAN_ONE, linkVisibility],
      );

    await setLinkVisibility(SubprofileLinkVisibility.Unlinked);
    try {
      const landing = await freshService().getPublicLanding();
      expect(landing.nextEvent).toBeNull();
    } finally {
      await setLinkVisibility(SubprofileLinkVisibility.Linked);
    }
    const relinked = await freshService().getPublicLanding();
    expect(relinked.nextEvent?.slug).toBe('public-next');
  });

  it('orders founding artist cards first, then by position', async () => {
    const landing = await freshService().getPublicLanding();

    expect(
      landing.artists.map((card) => ({
        handle: card.artist.handle,
        quote: card.quote,
        isFoundingArtist: card.isFoundingArtist,
      })),
    ).toEqual([
      {
        handle: 'musician-three',
        quote: 'Quote of musician-three',
        isFoundingArtist: true,
      },
      {
        handle: 'musician-one',
        quote: 'Quote of musician-one',
        isFoundingArtist: false,
      },
      {
        handle: 'musician-two',
        quote: 'Quote of musician-two',
        isFoundingArtist: false,
      },
    ]);
  });

  it('serves a linked persona avatar as stored and nulls a member key on an unlinked persona', async () => {
    const landing = await freshService().getPublicLanding();
    const avatarByHandle = Object.fromEntries(
      landing.artists.map((card) => [
        card.artist.handle,
        card.artist.avatarUrl,
      ]),
    );

    expect(avatarByHandle['musician-one']).toBe(
      `${API_BASE}/files/${LINKED_AVATAR_KEY}`,
    );
    expect(avatarByHandle['musician-two']).toBeNull();
    expect(JSON.stringify(landing)).not.toContain(UNLINKED_AVATAR_KEY);
  });

  it('refuses the stream of an approved preview that turned ineligible', async () => {
    const trackId = firstTrackOf(MUSICIAN_FOUR);
    const previewId = previewOf(trackId);

    expect(await freshService().getPreviewStream(previewId)).toEqual({
      url: SIGNED_URL,
      expiresAt: EXPIRES_AT,
    });
    expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
      `studio-audio/${ACTIVE_OWNER}/${trackId}.mp3`,
      'audio/mpeg',
      210,
    );

    storage.createPresignedAudioStream.mockClear();
    await setTrackColumn(
      trackId,
      `"staff_content_warnings" = ARRAY['violence']`,
    );
    await expect(
      freshService().getPreviewStream(previewId),
    ).rejects.toMatchObject({
      response: {
        statusCode: 404,
        code: 'studio_landing_preview_unavailable',
      },
    });
    expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    expect(await previewStatusOf(trackId)).toBe('approved');
    await setTrackColumn(trackId, `"staff_content_warnings" = '{}'`);
  });
});
