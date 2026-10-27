import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import { Profile } from '../users/entities/profile.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  MEMBER_PERSONAS_SQL,
  OPTED_IN_COUNT_SQL,
  StudioSupportersService,
  SUPPORTER_ARTIST_SQL,
  SUPPORTER_DELETE_SQL,
  SUPPORTER_PERSONAS_SQL,
  SUPPORTER_ROW_SQL,
  SUPPORTER_UPSERT_SQL,
  SUPPORTING_ROWS_SQL,
  TOP_SUPPORTERS_SQL,
} from './studio-supporters.service';
import { SupporterPersonaRow } from './studio-supporters';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

const USER_ID = 'fb000000-0000-4000-8000-000000000001';
const SUPPORTER_USER_ID = 'fb000000-0000-4000-8000-000000000002';
const ARTIST_ID = 'fb000000-0000-4000-8000-000000000101';
const OTHER_ARTIST_ID = 'fb000000-0000-4000-8000-000000000102';
const QUIET_ARTIST_ID = 'fb000000-0000-4000-8000-000000000103';
const PERSONA_A = 'fb000000-0000-4000-8000-000000000201';
const PERSONA_B = 'fb000000-0000-4000-8000-000000000202';
const FOREIGN_PERSONA = 'fb000000-0000-4000-8000-000000000203';
const GONE_PERSONA = 'fb000000-0000-4000-8000-000000000204';

const ARTIST_KINDS = [...STUDIO_ARTIST_PERSONA_KINDS];

const ARTIST_ROW = {
  artist_id: ARTIST_ID,
  artist_handle: 'harbour-lights',
  artist_display_name: 'Harbour Lights',
  artist_kind: 'musician',
  artist_avatar_url: null,
  is_own_persona: false,
};

const PERSONA_A_ROW: SupporterPersonaRow = {
  id: PERSONA_A,
  handle: 'night-ferry',
  display_name: 'Night Ferry',
  kind: 'developer',
  avatar_url: null,
  is_linkable: true,
};

const PERSONA_B_ROW: SupporterPersonaRow = {
  id: PERSONA_B,
  handle: null,
  display_name: 'Paper Lanterns',
  kind: 'writer',
  avatar_url: null,
  is_linkable: false,
};

const USER_PROFILE: Partial<Profile> = {
  userId: USER_ID,
  slug: 'sam-lee',
  firstName: 'Sam',
  lastName: 'Lee',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

const ACCOUNT_IDENTITY = {
  kind: 'account',
  member: { slug: 'sam-lee', displayName: 'Sam Lee', avatarUrl: null },
};

const PERSONA_A_IDENTITY = {
  kind: 'persona',
  persona: {
    id: PERSONA_A,
    handle: 'night-ferry',
    name: 'Night Ferry',
    kind: 'developer',
    avatarUrl: null,
    isLinkable: true,
  },
};

const PERSONA_B_IDENTITY = {
  kind: 'persona',
  persona: {
    id: PERSONA_B,
    handle: '',
    name: 'Paper Lanterns',
    kind: 'writer',
    avatarUrl: null,
    isLinkable: false,
  },
};

const ARTIST_NOT_FOUND_BODY = {
  statusCode: 404,
  code: 'studio_supporter_artist_not_found',
  message: 'This artist is not available to support.',
};

interface QueryAnswers {
  artistRows: unknown[];
  memberPersonaRows: SupporterPersonaRow[];
  chosenPersonaRows: SupporterPersonaRow[];
  supporterRows: unknown[];
  supportingRows: unknown[];
  topSupporterRows: unknown[];
  optedInCountRows: unknown[];
}

function defaultAnswers(): QueryAnswers {
  return {
    artistRows: [ARTIST_ROW],
    memberPersonaRows: [PERSONA_A_ROW],
    chosenPersonaRows: [],
    supporterRows: [],
    supportingRows: [],
    topSupporterRows: [],
    optedInCountRows: [{ count: 0 }],
  };
}

/** The response body of a refused call. */
async function refusalBodyOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse();
    }
    throw error;
  }
  throw new Error('The call resolved; a refusal was expected');
}

describe('StudioSupportersService', () => {
  let answers: QueryAnswers;
  let query: jest.Mock;
  let profiles: { find: jest.Mock };
  let socialLinks: { find: jest.Mock };
  let followers: { viewerFollowingFor: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock };
  let service: StudioSupportersService;

  const sqlCalled = (): string[] =>
    query.mock.calls.map((call: unknown[]) => call[0] as string);

  beforeEach(() => {
    answers = defaultAnswers();
    query = jest.fn((sql: string, parameters: unknown[]) => {
      switch (sql) {
        case SUPPORTER_ARTIST_SQL:
          return Promise.resolve(answers.artistRows);
        case MEMBER_PERSONAS_SQL:
          return Promise.resolve(
            answers.memberPersonaRows.filter(
              (row) => parameters[2] === null || row.id === parameters[2],
            ),
          );
        case SUPPORTER_PERSONAS_SQL:
          return Promise.resolve(answers.chosenPersonaRows);
        case SUPPORTER_ROW_SQL:
          return Promise.resolve(answers.supporterRows);
        case SUPPORTING_ROWS_SQL:
          return Promise.resolve(answers.supportingRows);
        case TOP_SUPPORTERS_SQL:
          return Promise.resolve(answers.topSupporterRows);
        case OPTED_IN_COUNT_SQL:
          return Promise.resolve(answers.optedInCountRows);
        default:
          return Promise.resolve([]);
      }
    });
    profiles = { find: jest.fn().mockResolvedValue([USER_PROFILE]) };
    socialLinks = { find: jest.fn().mockResolvedValue([]) };
    followers = { viewerFollowingFor: jest.fn().mockResolvedValue(new Set()) };
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(true) };
    service = new StudioSupportersService(
      { query } as unknown as DataSource,
      profiles as unknown as Repository<Profile>,
      socialLinks as unknown as Repository<SubprofileSocialLink>,
      followers as unknown as SubprofileFollowersService,
      ownership as unknown as StudioOwnershipService,
    );
  });

  describe('getSupporterState', () => {
    it('answers 404 studio_supporter_artist_not_found when the artist read finds nothing', async () => {
      answers.artistRows = [];

      const body = await refusalBodyOf(
        service.getSupporterState(USER_ID, ARTIST_ID),
      );

      expect(body).toEqual(ARTIST_NOT_FOUND_BODY);
      expect(query.mock.calls).toEqual([
        [SUPPORTER_ARTIST_SQL, [ARTIST_ID, USER_ID, ARTIST_KINDS]],
      ]);
    });

    it('answers 403 studio_supporter_own_persona to a persona member', async () => {
      answers.artistRows = [{ ...ARTIST_ROW, is_own_persona: true }];

      const body = await refusalBodyOf(
        service.getSupporterState(USER_ID, ARTIST_ID),
      );

      expect(body).toEqual({
        statusCode: 403,
        code: 'studio_supporter_own_persona',
        message:
          'You are a member of this artist, so you cannot be its supporter.',
      });
      expect(sqlCalled()).toEqual([SUPPORTER_ARTIST_SQL]);
    });

    it('lists your account first, then your personas by name, and says when you are not supporting', async () => {
      answers.memberPersonaRows = [PERSONA_A_ROW];

      const state = await service.getSupporterState(USER_ID, ARTIST_ID);

      expect(state).toEqual({
        isSupporting: false,
        shownAsSubprofileId: null,
        shownAs: null,
        since: null,
        options: [
          { shownAsSubprofileId: null, identity: ACCOUNT_IDENTITY },
          { shownAsSubprofileId: PERSONA_A, identity: PERSONA_A_IDENTITY },
        ],
      });
      expect(query).toHaveBeenCalledWith(MEMBER_PERSONAS_SQL, [
        USER_ID,
        ARTIST_ID,
        null,
      ]);
      expect(query).toHaveBeenCalledWith(SUPPORTER_ROW_SQL, [
        USER_ID,
        ARTIST_ID,
      ]);
    });

    it('shows the chosen identity and the opt-in date', async () => {
      answers.supporterRows = [
        {
          shown_as_subprofile_id: PERSONA_A,
          created_at: new Date('2026-10-20T08:00:00.123Z'),
        },
      ];

      const state = await service.getSupporterState(USER_ID, ARTIST_ID);

      expect(state).toEqual({
        isSupporting: true,
        shownAsSubprofileId: PERSONA_A,
        shownAs: PERSONA_A_IDENTITY,
        since: '2026-10-20T08:00:00.123Z',
        options: [
          { shownAsSubprofileId: null, identity: ACCOUNT_IDENTITY },
          { shownAsSubprofileId: PERSONA_A, identity: PERSONA_A_IDENTITY },
        ],
      });
      expect(sqlCalled()).not.toContain(SUPPORTER_PERSONAS_SQL);
    });

    it('keeps showing a chosen persona that left the options', async () => {
      answers.memberPersonaRows = [];
      answers.chosenPersonaRows = [PERSONA_B_ROW];
      answers.supporterRows = [
        {
          shown_as_subprofile_id: PERSONA_B,
          created_at: new Date('2026-10-21T09:30:00.000Z'),
        },
      ];

      const state = await service.getSupporterState(USER_ID, ARTIST_ID);

      expect(state).toEqual({
        isSupporting: true,
        shownAsSubprofileId: PERSONA_B,
        shownAs: PERSONA_B_IDENTITY,
        since: '2026-10-21T09:30:00.000Z',
        options: [{ shownAsSubprofileId: null, identity: ACCOUNT_IDENTITY }],
      });
      expect(query).toHaveBeenCalledWith(SUPPORTER_PERSONAS_SQL, [[PERSONA_B]]);
    });

    it('shows the account opt-in', async () => {
      answers.supporterRows = [
        {
          shown_as_subprofile_id: null,
          created_at: '2026-10-22T10:00:00.000Z',
        },
      ];

      const state = await service.getSupporterState(USER_ID, ARTIST_ID);

      expect([
        state.isSupporting,
        state.shownAsSubprofileId,
        state.shownAs,
        state.since,
      ]).toEqual([true, null, ACCOUNT_IDENTITY, '2026-10-22T10:00:00.000Z']);
    });
  });

  describe('setSupporter', () => {
    it('checks the artist before the identity', async () => {
      answers.artistRows = [];

      const body = await refusalBodyOf(
        service.setSupporter(USER_ID, ARTIST_ID, FOREIGN_PERSONA),
      );

      expect(body).toEqual(ARTIST_NOT_FOUND_BODY);
      expect(sqlCalled()).toEqual([SUPPORTER_ARTIST_SQL]);
      expect(sqlCalled()).not.toContain(MEMBER_PERSONAS_SQL);
    });

    it('answers 403 studio_supporter_own_persona to a persona member before the identity', async () => {
      answers.artistRows = [{ ...ARTIST_ROW, is_own_persona: true }];

      const body = await refusalBodyOf(
        service.setSupporter(USER_ID, ARTIST_ID, PERSONA_A),
      );

      expect(body).toEqual(
        expect.objectContaining({ code: 'studio_supporter_own_persona' }),
      );
      expect(sqlCalled()).toEqual([SUPPORTER_ARTIST_SQL]);
    });

    it('answers 403 studio_supporter_identity_not_yours for a persona the caller does not run', async () => {
      const body = await refusalBodyOf(
        service.setSupporter(USER_ID, ARTIST_ID, FOREIGN_PERSONA),
      );

      expect(body).toEqual({
        statusCode: 403,
        code: 'studio_supporter_identity_not_yours',
        message:
          'You can show yourself only as your account or a persona you are a member of.',
      });
      expect(query).toHaveBeenCalledWith(MEMBER_PERSONAS_SQL, [
        USER_ID,
        ARTIST_ID,
        FOREIGN_PERSONA,
      ]);
      expect(sqlCalled()).not.toContain(SUPPORTER_UPSERT_SQL);
    });

    it('upserts null for the account and answers the fresh state', async () => {
      answers.supporterRows = [
        {
          shown_as_subprofile_id: null,
          created_at: new Date('2026-10-23T11:00:00.000Z'),
        },
      ];

      const state = await service.setSupporter(USER_ID, ARTIST_ID, null);

      expect(query).toHaveBeenCalledWith(SUPPORTER_UPSERT_SQL, [
        USER_ID,
        ARTIST_ID,
        null,
      ]);
      const calledSql = sqlCalled();
      expect(calledSql.indexOf(SUPPORTER_UPSERT_SQL)).toBeLessThan(
        calledSql.indexOf(SUPPORTER_ROW_SQL),
      );
      expect(calledSql.filter((sql) => sql === MEMBER_PERSONAS_SQL)).toEqual([
        MEMBER_PERSONAS_SQL,
      ]);
      expect(state).toEqual({
        isSupporting: true,
        shownAsSubprofileId: null,
        shownAs: ACCOUNT_IDENTITY,
        since: '2026-10-23T11:00:00.000Z',
        options: [
          { shownAsSubprofileId: null, identity: ACCOUNT_IDENTITY },
          { shownAsSubprofileId: PERSONA_A, identity: PERSONA_A_IDENTITY },
        ],
      });
    });

    it('upserts a persona the caller is a member of', async () => {
      answers.supporterRows = [
        {
          shown_as_subprofile_id: PERSONA_A,
          created_at: new Date('2026-10-23T11:00:00.000Z'),
        },
      ];

      const state = await service.setSupporter(USER_ID, ARTIST_ID, PERSONA_A);

      expect(query).toHaveBeenCalledWith(MEMBER_PERSONAS_SQL, [
        USER_ID,
        ARTIST_ID,
        PERSONA_A,
      ]);
      expect(query).toHaveBeenCalledWith(SUPPORTER_UPSERT_SQL, [
        USER_ID,
        ARTIST_ID,
        PERSONA_A,
      ]);
      expect(state.shownAs).toEqual(PERSONA_A_IDENTITY);
    });

    it('answers every artist refusal with the same 404 body', async () => {
      // The artist read answers no row for an unknown id, another kind, a
      // hidden persona, a block with a co-owner and an identity block by the
      // caller; the Postgres spec pins each case in SQL.
      answers.artistRows = [];
      const refusedArtistIds = [
        'fb000000-0000-4000-8000-000000000901',
        'fb000000-0000-4000-8000-000000000902',
        'fb000000-0000-4000-8000-000000000903',
        'fb000000-0000-4000-8000-000000000904',
        'fb000000-0000-4000-8000-000000000905',
      ];

      const bodies: unknown[] = [];
      for (const refusedArtistId of refusedArtistIds) {
        bodies.push(
          await refusalBodyOf(
            service.setSupporter(USER_ID, refusedArtistId, null),
          ),
        );
      }

      expect(bodies).toHaveLength(refusedArtistIds.length);
      for (const body of bodies) expect(body).toEqual(ARTIST_NOT_FOUND_BODY);
      expect(sqlCalled()).not.toContain(SUPPORTER_UPSERT_SQL);
    });
  });

  it('deletes the caller row with no persona read', async () => {
    await service.removeSupporter(USER_ID, ARTIST_ID);

    expect(query.mock.calls).toEqual([
      [SUPPORTER_DELETE_SQL, [USER_ID, ARTIST_ID]],
    ]);
    expect(ownership.isPersonaMember).not.toHaveBeenCalled();
  });

  describe('listSupporting', () => {
    it('lists supporting rows with since, identity, support links in link order and the follow state', async () => {
      answers.supportingRows = [
        {
          artist_id: OTHER_ARTIST_ID,
          artist_handle: 'tram-28',
          artist_display_name: 'Tram 28',
          artist_kind: 'dj',
          artist_avatar_url: null,
          shown_as_subprofile_id: null,
          created_at: new Date('2026-10-24T08:00:00.000Z'),
        },
        {
          ...ARTIST_ROW,
          shown_as_subprofile_id: PERSONA_A,
          created_at: new Date('2026-10-20T08:00:00.000Z'),
        },
        {
          artist_id: QUIET_ARTIST_ID,
          artist_handle: 'quiet-hours',
          artist_display_name: 'Quiet Hours',
          artist_kind: 'poet',
          artist_avatar_url: null,
          shown_as_subprofile_id: GONE_PERSONA,
          created_at: new Date('2026-10-19T08:00:00.000Z'),
        },
      ];
      answers.chosenPersonaRows = [PERSONA_A_ROW];
      const artistLinks: Partial<SubprofileSocialLink>[] = [
        {
          subprofileId: ARTIST_ID,
          platform: 'bandcamp',
          urlOrHandle: 'harbourlights.bandcamp.com',
          position: 0,
        },
        {
          subprofileId: OTHER_ARTIST_ID,
          platform: 'kofi',
          urlOrHandle: 'tram28',
          position: 1,
        },
        {
          subprofileId: ARTIST_ID,
          platform: 'patreon',
          urlOrHandle: 'harbourlights',
          position: 2,
        },
      ];
      socialLinks.find.mockResolvedValue(artistLinks);
      followers.viewerFollowingFor.mockResolvedValue(new Set([ARTIST_ID]));

      const response = await service.listSupporting(USER_ID);

      expect(response).toEqual({
        items: [
          {
            artist: {
              id: OTHER_ARTIST_ID,
              handle: 'tram-28',
              name: 'Tram 28',
              kind: 'dj',
              avatarUrl: null,
            },
            since: '2026-10-24T08:00:00.000Z',
            shownAs: ACCOUNT_IDENTITY,
            supportLinks: [{ platform: 'kofi', urlOrHandle: 'tram28' }],
            isFollowing: false,
          },
          {
            artist: {
              id: ARTIST_ID,
              handle: 'harbour-lights',
              name: 'Harbour Lights',
              kind: 'musician',
              avatarUrl: null,
            },
            since: '2026-10-20T08:00:00.000Z',
            shownAs: PERSONA_A_IDENTITY,
            supportLinks: [
              {
                platform: 'bandcamp',
                urlOrHandle: 'harbourlights.bandcamp.com',
              },
              { platform: 'patreon', urlOrHandle: 'harbourlights' },
            ],
            isFollowing: true,
          },
        ],
      });
      expect(query).toHaveBeenCalledWith(SUPPORTING_ROWS_SQL, [
        USER_ID,
        ARTIST_KINDS,
      ]);
      expect(query).toHaveBeenCalledWith(SUPPORTER_PERSONAS_SQL, [
        [PERSONA_A, GONE_PERSONA],
      ]);
      expect(socialLinks.find).toHaveBeenCalledWith({
        where: {
          subprofileId: In([OTHER_ARTIST_ID, ARTIST_ID, QUIET_ARTIST_ID]),
          platform: In(['bandcamp', 'kofi', 'patreon']),
        },
        order: { position: 'ASC', createdAt: 'ASC', id: 'ASC' },
      });
      expect(followers.viewerFollowingFor).toHaveBeenCalledWith(USER_ID, [
        OTHER_ARTIST_ID,
        ARTIST_ID,
        QUIET_ARTIST_ID,
      ]);
      expect(profiles.find).toHaveBeenCalledTimes(1);
      expect(
        sqlCalled().filter((sql) => sql === SUPPORTER_PERSONAS_SQL),
      ).toHaveLength(1);
    });

    it('answers an empty list with no further reads', async () => {
      const response = await service.listSupporting(USER_ID);

      expect(response).toEqual({ items: [] });
      expect(sqlCalled()).toEqual([SUPPORTING_ROWS_SQL]);
      expect(socialLinks.find).not.toHaveBeenCalled();
      expect(followers.viewerFollowingFor).not.toHaveBeenCalled();
    });
  });

  describe('listTopSupporters', () => {
    it('answers 404 Artist not found to a non-member before reading', async () => {
      ownership.isPersonaMember.mockResolvedValue(false);

      await expect(
        service.listTopSupporters(USER_ID, ARTIST_ID),
      ).rejects.toThrow(new NotFoundException('Artist not found'));
      expect(ownership.isPersonaMember).toHaveBeenCalledWith(
        USER_ID,
        ARTIST_ID,
      );
      expect(query).not.toHaveBeenCalled();
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('maps ranked rows to identities in rank order with no counts or user ids', async () => {
      answers.topSupporterRows = [
        { user_id: USER_ID, shown_as_subprofile_id: null },
        { user_id: SUPPORTER_USER_ID, shown_as_subprofile_id: PERSONA_A },
        { user_id: SUPPORTER_USER_ID, shown_as_subprofile_id: GONE_PERSONA },
      ];
      answers.chosenPersonaRows = [PERSONA_A_ROW];
      answers.optedInCountRows = [{ count: 12 }];

      const result = await service.listTopSupporters(USER_ID, ARTIST_ID);

      expect(result.items).toEqual([
        { identity: ACCOUNT_IDENTITY },
        { identity: PERSONA_A_IDENTITY },
      ]);
      expect(result.optedInCount).toEqual({
        value: 12,
        isBelowThreshold: false,
      });
      expect(JSON.stringify(result)).not.toContain(SUPPORTER_USER_ID);
      expect(JSON.stringify(result)).not.toContain(USER_ID);
      expect(query).toHaveBeenCalledWith(TOP_SUPPORTERS_SQL, [ARTIST_ID, 10]);
      expect(query).toHaveBeenCalledWith(OPTED_IN_COUNT_SQL, [ARTIST_ID]);
      expect(query).toHaveBeenCalledWith(SUPPORTER_PERSONAS_SQL, [
        [PERSONA_A, GONE_PERSONA],
      ]);
    });

    it('lists a persona once when two co-owners both show as it', async () => {
      answers.topSupporterRows = [
        { user_id: SUPPORTER_USER_ID, shown_as_subprofile_id: PERSONA_A },
        { user_id: USER_ID, shown_as_subprofile_id: PERSONA_A },
      ];
      answers.chosenPersonaRows = [PERSONA_A_ROW];

      const result = await service.listTopSupporters(USER_ID, ARTIST_ID);

      expect(result.items).toEqual([{ identity: PERSONA_A_IDENTITY }]);
    });

    it('ranks one row per shown identity in the query', () => {
      expect(TOP_SUPPORTERS_SQL).toContain(
        'DISTINCT ON ("ranked"."identity_key")',
      );
      expect(TOP_SUPPORTERS_SQL).toContain(
        `'persona:' || "supporter"."shown_as_subprofile_id"::text`,
      );
      expect(TOP_SUPPORTERS_SQL).toContain('LIMIT $2');
    });

    it('offers only personas the owner side would show in the picker', () => {
      expect(MEMBER_PERSONAS_SQL).toContain(
        '"chosen_persona_moderation"."hidden_at" IS NOT NULL',
      );
      expect(MEMBER_PERSONAS_SQL).toContain(
        '"chosen_persona_moderation"."removed_at" IS NOT NULL',
      );
      expect(MEMBER_PERSONAS_SQL).toContain(
        '"chosen_persona"."id" = "persona"."id"',
      );
    });

    it('floors the opted-in count', async () => {
      answers.optedInCountRows = [{ count: '3' }];

      const result = await service.listTopSupporters(USER_ID, ARTIST_ID);

      expect(result).toEqual({
        items: [],
        optedInCount: { value: null, isBelowThreshold: true },
      });
    });
  });
});
