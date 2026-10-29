import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import {
  LandingArtistCardRow,
  LandingNextEventRow,
  LandingPhotoRow,
  LandingPreviewRow,
  OwnerPreviewRow,
  StudioLandingResponse,
  toStudioLandingArtistCard,
  toStudioLandingCounts,
  toStudioLandingNextEvent,
  toStudioLandingPhoto,
  toStudioLandingPreviewCard,
  toStudioLandingPreviewOwnerItem,
} from './studio-landing-response';

const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const PERSONA_ID = '22222222-2222-4222-8222-222222222222';
const TRACK_ID = '33333333-3333-4333-8333-333333333333';
const RELEASE_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const PREVIEW_ID = '66666666-6666-4666-8666-666666666666';
const CARD_ID = '77777777-7777-4777-8777-777777777777';

const PERSONA_AVATAR_KEY =
  'persona/88888888-8888-4888-8888-888888888881/88888888-8888-4888-8888-888888888882.jpg';
const PERSONA_COVER_KEY =
  'persona/99999999-9999-4999-8999-999999999991/99999999-9999-4999-8999-999999999992.jpg';
const LANDING_PHOTO_KEY =
  'studio-landing/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2.jpg';

const LANDING_KEYS = {
  root: ['artists', 'counts', 'nextEvent', 'photos', 'previews'],
  counts: ['artists', 'eventsThisMonth', 'releases'],
  photos: ['hero', 'manifesto'],
  persona: ['avatarUrl', 'handle', 'kind', 'name'],
  nextEvent: [
    'area',
    'artist',
    'isOnline',
    'slug',
    'startAt',
    'timezone',
    'title',
  ],
  preview: ['artist', 'coverUrl', 'durationSeconds', 'id', 'trackTitle'],
  artistCard: ['artist', 'id', 'isFoundingArtist', 'quote'],
  photo: ['altText', 'credit', 'url'],
  ownerItem: [
    'canApprove',
    'canDecline',
    'canWithdraw',
    'decidedAt',
    'id',
    'isEligible',
    'mainArtist',
    'relation',
    'release',
    'requestedAt',
    'status',
    'track',
  ],
};

beforeAll(() => {
  setImageUrlBase('https://api.example.test');
});

afterAll(() => {
  resetImageUrlBaseForTesting();
});

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

/** Every row also carries the ids a query selects for joins and render keys. */
function buildPayloadFromFixtures(): StudioLandingResponse {
  const personaColumns = {
    artist_handle: 'nova',
    artist_display_name: 'Nova',
    artist_kind: 'musician',
    artist_avatar_url: PERSONA_AVATAR_KEY,
    artist_link_visibility: 'unlinked',
    artist_id: PERSONA_ID,
    artist_user_id: MEMBER_ID,
  };
  const eventRow: LandingNextEventRow = {
    ...personaColumns,
    slug: 'night-out',
    title: 'Night Out',
    start_at: new Date('2026-11-02T20:00:00.000Z'),
    timezone: 'Europe/Lisbon',
    neighbourhood: 'Arroios',
    is_online: false,
    ...{ id: EVENT_ID, host_user_id: MEMBER_ID },
  };
  const previewRow: LandingPreviewRow = {
    ...personaColumns,
    id: PREVIEW_ID,
    track_title: 'Night Drive',
    duration_seconds: 187,
    cover_key: PERSONA_COVER_KEY,
    ...{ track_id: TRACK_ID, release_id: RELEASE_ID },
  };
  const cardRow: LandingArtistCardRow = {
    ...personaColumns,
    id: CARD_ID,
    quote: 'Glad to be here',
    is_founding_artist: true,
    ...{ subprofile_id: PERSONA_ID, created_by_id: MEMBER_ID },
  };
  const photoRow: LandingPhotoRow = {
    image_key: LANDING_PHOTO_KEY,
    alt_text_en: 'A crowd dancing',
    alt_text_pt: 'Uma multidao a dancar',
    credit: 'Ana Silva',
    ...{ slot: 'hero', updated_by_id: MEMBER_ID },
  };
  return {
    counts: toStudioLandingCounts({
      artists: 12,
      releases: 30,
      events_this_month: 6,
    }),
    nextEvent: toStudioLandingNextEvent(eventRow),
    previews: [toStudioLandingPreviewCard(previewRow)],
    artists: [toStudioLandingArtistCard(cardRow)],
    photos: { hero: toStudioLandingPhoto(photoRow), manifesto: null },
  };
}

describe('studio landing privacy', () => {
  it('serializes only the allowlisted keys', () => {
    const payload = buildPayloadFromFixtures();
    const nextEvent = payload.nextEvent;
    const preview = payload.previews[0];
    const artistCard = payload.artists[0];
    const hero = payload.photos.hero;

    expect(sortedKeys(payload)).toEqual(LANDING_KEYS.root);
    expect(sortedKeys(payload.counts)).toEqual(LANDING_KEYS.counts);
    expect(sortedKeys(payload.photos)).toEqual(LANDING_KEYS.photos);
    expect(nextEvent ? sortedKeys(nextEvent) : null).toEqual(
      LANDING_KEYS.nextEvent,
    );
    expect(nextEvent ? sortedKeys(nextEvent.artist) : null).toEqual(
      LANDING_KEYS.persona,
    );
    expect(preview ? sortedKeys(preview) : null).toEqual(LANDING_KEYS.preview);
    expect(preview ? sortedKeys(preview.artist) : null).toEqual(
      LANDING_KEYS.persona,
    );
    expect(artistCard ? sortedKeys(artistCard) : null).toEqual(
      LANDING_KEYS.artistCard,
    );
    expect(artistCard ? sortedKeys(artistCard.artist) : null).toEqual(
      LANDING_KEYS.persona,
    );
    expect(hero ? sortedKeys(hero) : null).toEqual(LANDING_KEYS.photo);
    expect(hero ? sortedKeys(hero.altText) : null).toEqual(['en', 'pt']);
  });

  it('carries no id of a member, persona, track, release or event', () => {
    const serialized = JSON.stringify(buildPayloadFromFixtures());
    for (const sensitiveId of [
      MEMBER_ID,
      PERSONA_ID,
      TRACK_ID,
      RELEASE_ID,
      EVENT_ID,
    ]) {
      expect(serialized).not.toContain(sensitiveId);
    }
  });

  it('carries no member field in an owner preview item', () => {
    const row: OwnerPreviewRow = {
      id: PREVIEW_ID,
      status: 'approved',
      relation: 'credited',
      track_id: TRACK_ID,
      track_title: 'Night Drive',
      track_duration_seconds: 187,
      release_id: RELEASE_ID,
      release_title: 'Night Drive EP',
      release_cover_key: null,
      main_artist_id: PERSONA_ID,
      main_artist_handle: 'nova',
      main_artist_display_name: 'Nova',
      main_artist_kind: 'musician',
      main_artist_avatar_url: null,
      requested_at: new Date('2026-10-20T10:00:00.000Z'),
      decided_at: new Date('2026-10-21T10:00:00.000Z'),
      is_eligible: true,
      ...{ decided_by_id: MEMBER_ID, requested_by_id: MEMBER_ID },
    };
    const item = toStudioLandingPreviewOwnerItem(row);
    expect(sortedKeys(item)).toEqual(LANDING_KEYS.ownerItem);
    expect(JSON.stringify(item)).not.toContain(MEMBER_ID);
  });
});
