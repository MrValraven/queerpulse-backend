import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { SubprofileKind } from '../subprofiles/entities/subprofile.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import {
  EMPTY_PLAYLIST_STATS,
  StudioPlaylistCardSource,
  memberDisplayName,
  toStudioPlaylistCard,
  toStudioPlaylistCredit,
  toStudioPlaylistMemberCredit,
  toStudioPlaylistResponse,
} from './studio-playlist-response';
import { StudioArtistPersona } from './studio-response';

const OWNER_ID = 'owner-1';
const PERSONA_ID = 'persona-1';
const coverKey = (index: number): string =>
  `persona/c0000000-0000-4000-8000-00000000000${index}/c0000000-0000-4000-8000-00000000001${index}.jpg`;

const playlist = (overrides: Partial<StudioPlaylist> = {}): StudioPlaylist => ({
  id: 'playlist-1',
  userId: OWNER_ID,
  name: 'Night bus',
  description: 'For the N1',
  visibility: StudioPlaylistVisibility.Public,
  creditSubprofileId: null,
  isCreditedToPersona: false,
  createdAt: new Date('2026-10-10T09:00:00.000Z'),
  updatedAt: new Date('2026-10-11T09:00:00.000Z'),
  ...overrides,
});

const persona: StudioArtistPersona = {
  id: PERSONA_ID,
  handle: 'night-shift',
  displayName: 'Night Shift',
  kind: SubprofileKind.Dj,
  avatarUrl: null,
};

const member: MemberRef = {
  slug: 'ana-silva',
  firstName: 'Ana',
  lastName: 'Silva',
  pronouns: null,
  avatarUrl: null,
};

const source = (
  overrides: Partial<StudioPlaylistCardSource> = {},
): StudioPlaylistCardSource => ({
  playlist: playlist(),
  viewerId: 'viewer-1',
  isCreditBroken: false,
  persona: undefined,
  member,
  stats: EMPTY_PLAYLIST_STATS,
  coverKeys: [],
  ...overrides,
});

describe('Studio playlist mappers', () => {
  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  it('credits a member playlist to the member by name and profile slug and keeps owner fields from viewers', () => {
    const card = toStudioPlaylistCard(source());
    expect(card.credit).toEqual({
      persona: null,
      member: {
        id: OWNER_ID,
        slug: 'ana-silva',
        displayName: 'Ana Silva',
        avatarUrl: null,
      },
    });
    expect(card.isOwner).toBe(false);
    expect(card.visibility).toBeNull();
    expect(card.updatedAt).toBe('2026-10-11T09:00:00.000Z');
  });

  it('never names the owner of a persona-credited playlist', () => {
    const card = toStudioPlaylistCard(
      source({
        playlist: playlist({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
        persona,
      }),
    );
    expect(card.credit.member).toBeNull();
    expect(card.credit.persona).toEqual(
      expect.objectContaining({ id: PERSONA_ID, name: 'Night Shift' }),
    );
    expect(JSON.stringify(card)).not.toContain(OWNER_ID);
    expect(JSON.stringify(card)).not.toContain('Ana');
  });

  it('refuses to map a persona-credited playlist for a viewer without its persona', () => {
    expect(() =>
      toStudioPlaylistCard(
        source({
          playlist: playlist({ isCreditedToPersona: true }),
          isCreditBroken: true,
        }),
      ),
    ).toThrow(/without its persona/);
    expect(() =>
      toStudioPlaylistCredit(
        source({
          playlist: playlist({
            creditSubprofileId: PERSONA_ID,
            isCreditedToPersona: true,
          }),
        }),
      ),
    ).toThrow(/without its persona/);
  });

  it('shows the owner a broken persona credit as private under their own name', () => {
    const card = toStudioPlaylistCard(
      source({
        viewerId: OWNER_ID,
        playlist: playlist({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
        isCreditBroken: true,
      }),
    );
    expect(card.isOwner).toBe(true);
    expect(card.visibility).toBe('private');
    expect(card.credit.persona).toBeNull();
    expect(card.credit.member?.id).toBe(OWNER_ID);
  });

  it('shows the owner a standing persona credit under the persona with the stored visibility', () => {
    const card = toStudioPlaylistCard(
      source({
        viewerId: OWNER_ID,
        playlist: playlist({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
          visibility: StudioPlaylistVisibility.Connections,
        }),
        persona,
      }),
    );
    expect(card.isOwner).toBe(true);
    expect(card.visibility).toBe('connections');
    expect(card.credit.persona?.id).toBe(PERSONA_ID);
    expect(card.credit.member).toBeNull();
  });

  it('keeps four covers in the order it is given and reads them as image urls', () => {
    const card = toStudioPlaylistCard(
      source({ coverKeys: [1, 2, 3, 4, 5].map(coverKey) }),
    );
    expect(card.coverUrls).toEqual(
      [1, 2, 3, 4].map((index) => `https://api.test/files/${coverKey(index)}`),
    );
  });

  it('names a member with no profile as Member', () => {
    expect(memberDisplayName(undefined)).toBe('Member');
    expect(memberDisplayName({ ...member, firstName: '', lastName: '' })).toBe(
      'Member',
    );
  });

  it('gives a member with no profile an empty slug and the Member name', () => {
    expect(toStudioPlaylistMemberCredit(OWNER_ID, undefined)).toEqual({
      id: OWNER_ID,
      slug: '',
      displayName: 'Member',
      avatarUrl: null,
    });
  });

  it('gives the owner the credit id and hides it from everyone else and from a broken credit', () => {
    const creditedPlaylist = playlist({
      creditSubprofileId: PERSONA_ID,
      isCreditedToPersona: true,
    });
    const ownerCard = toStudioPlaylistCard(
      source({ viewerId: OWNER_ID, playlist: creditedPlaylist, persona }),
    );
    expect(
      toStudioPlaylistResponse(ownerCard, creditedPlaylist, [], false)
        .creditSubprofileId,
    ).toBe(PERSONA_ID);
    expect(
      toStudioPlaylistResponse(ownerCard, creditedPlaylist, [], true)
        .creditSubprofileId,
    ).toBeNull();
    const viewerCard = toStudioPlaylistCard(
      source({ playlist: creditedPlaylist, persona }),
    );
    const viewerResponse = toStudioPlaylistResponse(
      viewerCard,
      creditedPlaylist,
      [],
      false,
    );
    expect(viewerResponse.creditSubprofileId).toBeNull();
    expect(viewerResponse.description).toBe('For the N1');
  });
});
