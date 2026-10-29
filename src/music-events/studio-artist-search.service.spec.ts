import { HttpException } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { In } from 'typeorm';
import { foldedTextExpression } from '../connections/connection-search';
import { PAGE_SIZE } from '../common/pagination';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import { Profile } from '../users/entities/profile.entity';
import { StudioArtistSearchService } from './studio-artist-search.service';
import {
  STUDIO_ARTIST_BOOKABLE_SQL,
  STUDIO_ARTIST_PERSONAS_SQL,
  STUDIO_ARTIST_SEARCH_COUNT_SQL,
  STUDIO_ARTIST_SEARCH_SQL,
} from './studio-artist-sql';

const STAFF_USER_ID = 'staff-user-1';
const FIRST_MEMBER_ID = 'member-user-1';
const SECOND_MEMBER_ID = 'member-user-2';

function profileFixture(overrides: Partial<Profile>): Profile {
  const fixture: Partial<Profile> = {
    userId: FIRST_MEMBER_ID,
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    avatarUrl: null,
    photoVisible: true,
    ...overrides,
  };
  return fixture as Profile;
}

async function expectNotStudioArtist(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(403);
  expect(exception.getResponse()).toMatchObject({
    code: 'music_event_performer_not_studio_artist',
  });
}

describe('StudioArtistSearchService', () => {
  let service: StudioArtistSearchService;
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>();
  const find = jest.fn<Promise<Profile[]>, [unknown]>();

  /** Answers each SQL constant with its own rows. */
  const answerQueries = (rowsBySql: Map<string, unknown[]>): void => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(rowsBySql.get(sql) ?? []),
    );
  };

  beforeEach(async () => {
    query.mockReset();
    find.mockReset().mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudioArtistSearchService,
        { provide: getDataSourceToken(), useValue: { query } },
        { provide: getRepositoryToken(Profile), useValue: { find } },
      ],
    }).compile();
    service = moduleRef.get(StudioArtistSearchService);
  });

  it('passes null as the term for an empty query and the folded like term otherwise', async () => {
    answerQueries(new Map([[STUDIO_ARTIST_SEARCH_COUNT_SQL, [{ total: 0 }]]]));
    const artistKinds = [...STUDIO_ARTIST_PERSONA_KINDS];

    await service.search(STAFF_USER_ID, '   ', undefined);
    await service.search(STAFF_USER_ID, ' Ana_50% ', 3);

    const searchCalls = query.mock.calls.filter(
      ([sql]) => sql === STUDIO_ARTIST_SEARCH_SQL,
    );
    const countCalls = query.mock.calls.filter(
      ([sql]) => sql === STUDIO_ARTIST_SEARCH_COUNT_SQL,
    );
    expect(searchCalls.map(([, parameters]) => parameters)).toEqual([
      [null, STAFF_USER_ID, artistKinds, PAGE_SIZE, 0],
      ['%Ana\\_50\\%%', STAFF_USER_ID, artistKinds, PAGE_SIZE, 2 * PAGE_SIZE],
    ]);
    expect(countCalls.map(([, parameters]) => parameters)).toEqual([
      [null, STAFF_USER_ID, artistKinds],
      ['%Ana\\_50\\%%', STAFF_USER_ID, artistKinds],
    ]);
    // The pattern is folded in SQL, the same way as the haystack.
    expect(STUDIO_ARTIST_SEARCH_SQL).toContain(
      foldedTextExpression('$1::text'),
    );
  });

  it('keeps the SQL order when mapping profiles', async () => {
    answerQueries(
      new Map<string, unknown[]>([
        [
          STUDIO_ARTIST_SEARCH_SQL,
          [{ user_id: SECOND_MEMBER_ID }, { user_id: FIRST_MEMBER_ID }],
        ],
        [STUDIO_ARTIST_SEARCH_COUNT_SQL, [{ total: 2 }]],
      ]),
    );
    find.mockResolvedValue([
      profileFixture({}),
      profileFixture({
        userId: SECOND_MEMBER_ID,
        slug: 'bea-costa',
        firstName: 'Bea',
        lastName: 'Costa',
      }),
    ]);

    const page = await service.search(STAFF_USER_ID, undefined, undefined);

    expect(find).toHaveBeenCalledWith({
      where: { userId: In([SECOND_MEMBER_ID, FIRST_MEMBER_ID]) },
    });
    expect(page).toEqual({
      items: [
        {
          slug: 'bea-costa',
          firstName: 'Bea',
          lastName: 'Costa',
          avatarUrl: null,
          artistPersonas: [],
        },
        {
          slug: 'ana-silva',
          firstName: 'Ana',
          lastName: 'Silva',
          avatarUrl: null,
          artistPersonas: [],
        },
      ],
      total: 2,
      page: 1,
      pageSize: PAGE_SIZE,
    });
  });

  it('attaches linked personas per member', async () => {
    answerQueries(
      new Map<string, unknown[]>([
        [
          STUDIO_ARTIST_SEARCH_SQL,
          [{ user_id: FIRST_MEMBER_ID }, { user_id: SECOND_MEMBER_ID }],
        ],
        [STUDIO_ARTIST_SEARCH_COUNT_SQL, [{ total: 2 }]],
        [
          STUDIO_ARTIST_PERSONAS_SQL,
          [
            {
              id: 'persona-1',
              user_id: FIRST_MEMBER_ID,
              handle: 'ana-spins',
              display_name: 'Ana Spins',
              kind: 'dj',
            },
            {
              id: 'persona-2',
              user_id: SECOND_MEMBER_ID,
              handle: 'bea-sings',
              display_name: 'Bea Sings',
              kind: 'musician',
            },
            {
              id: 'persona-3',
              user_id: FIRST_MEMBER_ID,
              handle: 'ana-live',
              display_name: 'Ana Live',
              kind: 'performer',
            },
          ],
        ],
      ]),
    );
    find.mockResolvedValue([
      profileFixture({}),
      profileFixture({ userId: SECOND_MEMBER_ID, slug: 'bea-costa' }),
    ]);

    const page = await service.search(STAFF_USER_ID, 'a', 1);

    const personaCall = query.mock.calls.find(
      ([sql]) => sql === STUDIO_ARTIST_PERSONAS_SQL,
    );
    expect(personaCall?.[1]).toEqual([
      [FIRST_MEMBER_ID, SECOND_MEMBER_ID],
      [...STUDIO_ARTIST_PERSONA_KINDS],
    ]);
    expect(
      page.items.map((item) => ({
        slug: item.slug,
        artistPersonas: item.artistPersonas,
      })),
    ).toEqual([
      {
        slug: 'ana-silva',
        artistPersonas: [
          {
            subprofileId: 'persona-1',
            handle: 'ana-spins',
            displayName: 'Ana Spins',
            kind: 'dj',
          },
          {
            subprofileId: 'persona-3',
            handle: 'ana-live',
            displayName: 'Ana Live',
            kind: 'performer',
          },
        ],
      },
      {
        slug: 'bea-costa',
        artistPersonas: [
          {
            subprofileId: 'persona-2',
            handle: 'bea-sings',
            displayName: 'Bea Sings',
            kind: 'musician',
          },
        ],
      },
    ]);
  });

  it('refuses a blocked Studio artist with the same code as a non-artist', async () => {
    query.mockResolvedValueOnce([
      { is_studio_artist: true, is_blocked: false },
    ]);
    await expect(
      service.assertBookable(STAFF_USER_ID, FIRST_MEMBER_ID),
    ).resolves.toBeUndefined();

    query.mockResolvedValueOnce([{ is_studio_artist: true, is_blocked: true }]);
    await expectNotStudioArtist(
      service.assertBookable(STAFF_USER_ID, FIRST_MEMBER_ID),
    );

    query.mockResolvedValueOnce([
      { is_studio_artist: false, is_blocked: false },
    ]);
    await expectNotStudioArtist(
      service.assertBookable(STAFF_USER_ID, FIRST_MEMBER_ID),
    );

    query.mockResolvedValueOnce([]);
    await expectNotStudioArtist(
      service.assertBookable(STAFF_USER_ID, FIRST_MEMBER_ID),
    );

    expect(query).toHaveBeenCalledWith(STUDIO_ARTIST_BOOKABLE_SQL, [
      FIRST_MEMBER_ID,
      STAFF_USER_ID,
      [...STUDIO_ARTIST_PERSONA_KINDS],
    ]);
  });
});
