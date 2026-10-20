import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import {
  StudioCopyrightClaimsExportContributor,
  StudioPersonaCreditsExportContributor,
  StudioPlaylistAdditionsExportContributor,
  StudioPlaylistSeatsExportContributor,
  StudioPlaylistsExportContributor,
  StudioReleaseRemindersExportContributor,
} from './data-export-contributors-studio';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const USER_ID = '71000000-0000-4000-8000-000000000001';
const PLAYLIST_ID = '72000000-0000-4000-8000-000000000001';
const SECOND_PLAYLIST_ID = '72000000-0000-4000-8000-000000000002';

describe('StudioPlaylistsExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioPlaylistsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioPlaylistsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the saved category under its own archive key', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('studioPlaylists');
  });

  it('is registered and has a csv file after the persona content', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioPlaylistsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioPlaylists')).toBe(
      csvKeys.indexOf('personaContent') + 1,
    );
  });

  it('answers an empty list without reading entries when the member has no playlists', async () => {
    query.mockResolvedValueOnce([]);
    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
  });

  it('writes each playlist with its credit name and its tracks in order', async () => {
    query
      .mockResolvedValueOnce([
        {
          id: PLAYLIST_ID,
          name: 'Night bus',
          description: 'For the N1',
          visibility: 'public',
          credit_name: 'Night Shift',
          created_at: new Date('2026-10-10T09:00:00.000Z'),
          updated_at: new Date('2026-10-11T09:00:00.000Z'),
        },
        {
          id: SECOND_PLAYLIST_ID,
          name: 'Just mine',
          description: null,
          visibility: 'private',
          credit_name: null,
          created_at: new Date('2026-10-12T09:00:00.000Z'),
          updated_at: new Date('2026-10-12T09:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          playlist_id: PLAYLIST_ID,
          track_title: 'Opening',
          artist_name: 'Lia',
          added_at: new Date('2026-10-10T09:05:00.000Z'),
        },
        {
          playlist_id: PLAYLIST_ID,
          track_title: null,
          artist_name: null,
          added_at: new Date('2026-10-10T09:06:00.000Z'),
        },
      ]);

    const archive = await contributor.buildContribution(USER_ID);

    expect(query.mock.calls[1]?.[1]).toEqual([
      [PLAYLIST_ID, SECOND_PLAYLIST_ID],
    ]);
    expect(archive).toEqual([
      {
        id: PLAYLIST_ID,
        name: 'Night bus',
        description: 'For the N1',
        visibility: 'public',
        creditName: 'Night Shift',
        tracks: [
          {
            title: 'Opening',
            artist: 'Lia',
            addedAt: '2026-10-10T09:05:00.000Z',
          },
          {
            title: null,
            artist: null,
            addedAt: '2026-10-10T09:06:00.000Z',
          },
        ],
        createdAt: '2026-10-10T09:00:00.000Z',
        updatedAt: '2026-10-11T09:00:00.000Z',
      },
      {
        id: SECOND_PLAYLIST_ID,
        name: 'Just mine',
        description: null,
        visibility: 'private',
        creditName: null,
        tracks: [],
        createdAt: '2026-10-12T09:00:00.000Z',
        updatedAt: '2026-10-12T09:00:00.000Z',
      },
    ]);
  });

  it('reads only the playlists the member owns', async () => {
    query.mockResolvedValueOnce([]);
    await contributor.buildContribution(USER_ID);
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain(`WHERE "playlist"."user_id" = $1`);
    expect(sql).not.toContain('"credit_persona"."user_id"');
  });
});

describe('StudioPersonaCreditsExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioPersonaCreditsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioPersonaCreditsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the personas category under its own archive key', () => {
    expect(contributor.category).toBe('subprofiles');
    expect(contributor.archiveKey).toBe('studioPersonaCredits');
  });

  it('is registered and has a csv file right after the playlists', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioPersonaCreditsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioPersonaCredits')).toBe(
      csvKeys.indexOf('studioPlaylists') + 1,
    );
  });

  it('reads the credits given and received by every persona the member runs, by persona name', async () => {
    query.mockResolvedValueOnce([]);
    await contributor.buildContribution(USER_ID);

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([USER_ID]);
    expect(sql).toContain(`'given' AS "direction"`);
    expect(sql).toContain(`'received' AS "direction"`);
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain(
      `SELECT "member"."subprofile_id" FROM "subprofile_members" "member" WHERE "member"."user_id" = $1`,
    );
    // Persona names only: neither side's member account is read.
    expect(sql).not.toContain('"requested_by_user_id"');
    expect(sql).not.toContain('"users"');
  });

  it('writes one row per credit and direction with ISO dates', async () => {
    query.mockResolvedValueOnce([
      {
        direction: 'given',
        persona_name: 'Night Shift',
        other_persona_name: 'River Ink',
        role: 'cover-art',
        track_title: 'Opening',
        release_title: 'Lisbon at four',
        status: 'accepted',
        created_at: new Date('2026-10-10T09:00:00.000Z'),
        responded_at: new Date('2026-10-11T09:00:00.000Z'),
      },
      {
        direction: 'received',
        persona_name: 'River Ink',
        other_persona_name: 'Night Shift',
        role: 'producer',
        track_title: 'Closing',
        release_title: 'Lisbon at four',
        status: 'pending',
        created_at: new Date('2026-10-12T09:00:00.000Z'),
        responded_at: null,
      },
    ]);

    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([
      {
        direction: 'given',
        personaName: 'Night Shift',
        otherPersonaName: 'River Ink',
        role: 'cover-art',
        trackTitle: 'Opening',
        releaseTitle: 'Lisbon at four',
        status: 'accepted',
        createdAt: '2026-10-10T09:00:00.000Z',
        respondedAt: '2026-10-11T09:00:00.000Z',
      },
      {
        direction: 'received',
        personaName: 'River Ink',
        otherPersonaName: 'Night Shift',
        role: 'producer',
        trackTitle: 'Closing',
        releaseTitle: 'Lisbon at four',
        status: 'pending',
        createdAt: '2026-10-12T09:00:00.000Z',
        respondedAt: null,
      },
    ]);
  });
});

describe('StudioReleaseRemindersExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioReleaseRemindersExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioReleaseRemindersExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the saved category under its own archive key, after the persona credits', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('studioReleaseReminders');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioReleaseRemindersExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioReleaseReminders')).toBe(
      csvKeys.indexOf('studioPersonaCredits') + 1,
    );
  });

  it('writes each Notify me with the release, the artist and the dates', async () => {
    query.mockResolvedValueOnce([
      {
        release_title: 'Lisbon at four',
        artist_name: 'Night Shift',
        publish_at: new Date('2026-10-20T18:00:00.000Z'),
        created_at: new Date('2026-10-13T09:00:00.000Z'),
      },
      {
        release_title: 'Out already',
        artist_name: 'Night Shift',
        publish_at: null,
        created_at: new Date('2026-10-12T09:00:00.000Z'),
      },
    ]);

    expect(await contributor.buildContribution(USER_ID)).toEqual([
      {
        releaseTitle: 'Lisbon at four',
        artist: 'Night Shift',
        publishAt: '2026-10-20T18:00:00.000Z',
        createdAt: '2026-10-13T09:00:00.000Z',
      },
      {
        releaseTitle: 'Out already',
        artist: 'Night Shift',
        publishAt: null,
        createdAt: '2026-10-12T09:00:00.000Z',
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
    expect(query.mock.calls[0]?.[0]).toContain(
      'FROM "studio_release_reminders"',
    );
  });

  it('keeps every reminder and names the release only while it is scheduled or published', async () => {
    query.mockResolvedValueOnce([
      {
        release_title: null,
        artist_name: 'Night Shift',
        publish_at: null,
        created_at: new Date('2026-10-11T09:00:00.000Z'),
      },
    ]);

    expect(await contributor.buildContribution(USER_ID)).toEqual([
      {
        releaseTitle: null,
        artist: 'Night Shift',
        publishAt: null,
        createdAt: '2026-10-11T09:00:00.000Z',
      },
    ]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(
      /CASE WHEN "release"\."status" IN \('scheduled', 'published'\)\s+THEN "release"\."title" END AS "release_title"/,
    );
    // No status filter in the WHERE clause, so no reminder row is dropped.
    expect(sql.slice(sql.indexOf('WHERE'))).not.toContain('"status"');
  });
});

describe('StudioPlaylistSeatsExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioPlaylistSeatsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioPlaylistSeatsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the saved category under its own archive key, after the persona posts', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('studioPlaylistSeats');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioPlaylistSeatsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioPlaylistSeats')).toBe(
      csvKeys.indexOf('personaPosts') + 1,
    );
  });

  it('writes every seat the member holds or held, ended ones included', async () => {
    query.mockResolvedValueOnce([
      {
        playlist_name: 'Night bus',
        status: 'active',
        source: 'member_invite',
        invited_at: new Date('2026-10-14T09:00:00.000Z'),
        accepted_at: new Date('2026-10-14T09:30:00.000Z'),
        ended_at: null,
      },
      {
        playlist_name: 'As the persona',
        status: 'revoked',
        source: 'persona_co_owner',
        invited_at: new Date('2026-10-14T10:00:00.000Z'),
        accepted_at: null,
        ended_at: new Date('2026-10-15T08:00:00.000Z'),
      },
    ]);

    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([
      {
        playlistName: 'Night bus',
        status: 'active',
        source: 'member_invite',
        invitedAt: '2026-10-14T09:00:00.000Z',
        acceptedAt: '2026-10-14T09:30:00.000Z',
        endedAt: null,
      },
      {
        playlistName: 'As the persona',
        status: 'revoked',
        source: 'persona_co_owner',
        invitedAt: '2026-10-14T10:00:00.000Z',
        acceptedAt: null,
        endedAt: '2026-10-15T08:00:00.000Z',
      },
    ]);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([USER_ID]);
    expect(sql).toContain(`WHERE "editor"."user_id" = $1`);
    expect(sql).not.toContain('"status" IN');
  });

  it('names no other member', async () => {
    query.mockResolvedValueOnce([]);
    await contributor.buildContribution(USER_ID);
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).not.toContain('"invited_by_user_id"');
    expect(sql).not.toContain('"profiles"');
  });
});

describe('StudioPlaylistAdditionsExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioPlaylistAdditionsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioPlaylistAdditionsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the saved category right after the seats', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('studioPlaylistAdditions');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioPlaylistAdditionsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioPlaylistAdditions')).toBe(
      csvKeys.indexOf('studioPlaylistSeats') + 1,
    );
    expect(
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(
        StudioPlaylistAdditionsExportContributor,
      ),
    ).toBe(
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(
        StudioPlaylistSeatsExportContributor,
      ) + 1,
    );
  });

  it('writes the tracks the member added to playlists they do not own, a gone track with a null title', async () => {
    query.mockResolvedValueOnce([
      {
        playlist_name: 'Night bus',
        track_title: 'Opening',
        added_at: new Date('2026-10-14T09:05:00.000Z'),
      },
      {
        playlist_name: 'Night bus',
        track_title: null,
        added_at: new Date('2026-10-14T09:06:00.000Z'),
      },
    ]);

    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([
      {
        playlistName: 'Night bus',
        trackTitle: 'Opening',
        addedAt: '2026-10-14T09:05:00.000Z',
      },
      {
        playlistName: 'Night bus',
        trackTitle: null,
        addedAt: '2026-10-14T09:06:00.000Z',
      },
    ]);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([USER_ID]);
    expect(sql).toContain(`"entry"."added_by_user_id" = $1`);
    expect(sql).toContain(`"playlist"."user_id" <> $1`);
    expect(sql).toContain('LEFT JOIN "studio_tracks" "track"');
  });
});

describe('StudioCopyrightClaimsExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioCopyrightClaimsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioCopyrightClaimsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the reports category under its own archive key, after the playlist additions', () => {
    expect(contributor.category).toBe('reports');
    expect(contributor.archiveKey).toBe('studioCopyrightClaims');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioCopyrightClaimsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioCopyrightClaims')).toBe(
      csvKeys.indexOf('studioPlaylistAdditions') + 1,
    );
  });

  it("writes each of the member's claims with the track, the artist and every step", async () => {
    query.mockResolvedValueOnce([
      {
        track_title: 'Opening',
        artist_name: 'Night Shift',
        status: 'countered',
        claimant_role: 'rights_holder',
        original_work: 'Saudade by Ana Moura',
        original_link: null,
        details: 'The hook from 0:40',
        counter_note: 'I wrote every bar',
        claimant_reply: null,
        staff_note: null,
        created_at: new Date('2026-10-14T09:00:00.000Z'),
        accepted_at: new Date('2026-10-14T10:00:00.000Z'),
        countered_at: new Date('2026-10-14T11:00:00.000Z'),
        replied_at: null,
        decided_at: null,
      },
    ]);

    expect(await contributor.buildContribution(USER_ID)).toEqual([
      {
        trackTitle: 'Opening',
        artist: 'Night Shift',
        status: 'countered',
        claimantRole: 'rights_holder',
        originalWork: 'Saudade by Ana Moura',
        originalLink: null,
        details: 'The hook from 0:40',
        counterNote: 'I wrote every bar',
        claimantReply: null,
        staffNote: null,
        createdAt: '2026-10-14T09:00:00.000Z',
        acceptedAt: '2026-10-14T10:00:00.000Z',
        counteredAt: '2026-10-14T11:00:00.000Z',
        repliedAt: null,
        decidedAt: null,
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
    expect(query.mock.calls[0]?.[0]).toContain(
      'WHERE "claim"."claimant_id" = $1',
    );
    expect(query.mock.calls[0]?.[0]).not.toContain('decided_by_id');
  });

  // A persona unlink severs the claim: the archive names the track and
  // artist as they were at filing and reads no live row of the persona.
  it('exports a severed claim with the names kept at filing and joins no live row', async () => {
    query.mockResolvedValueOnce([]);

    await contributor.buildContribution(USER_ID);

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'COALESCE("track"."title", "claim"."track_title_at_filing") AS "track_title"',
    );
    expect(sql).toContain(
      'COALESCE("persona"."display_name", "claim"."artist_name_at_filing") AS "artist_name"',
    );
    expect(sql).toContain(
      'ON "track"."id" = "claim"."track_id" AND NOT "claim"."is_severed"',
    );
    expect(sql).toContain(
      'ON "release"."id" = "claim"."release_id" AND NOT "claim"."is_severed"',
    );
    expect(sql).toContain('ON "persona"."id" = "release"."subprofile_id"');
  });
});
