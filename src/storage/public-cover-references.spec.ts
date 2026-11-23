import { mediaReferenceVersion } from './media-reference-version';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { toCommunityCard } from '../communities/community-response';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { EventInvite } from '../events/entities/event-invite.entity';
import { toPendingEventInviteView } from '../events/event-invite-response';
import { toEventSummary } from '../events/event-response';
import { eventToFeedItem } from '../feed/feed-response';
import { LandingFeature } from '../landing/entities/landing-feature.entity';
import {
  toLandingCommunityFeatureDTO,
  toLandingGatheringFeatureDTO,
} from '../landing/landing-response';

// SEC-04: an event's or a community's cover is uploaded by one member (the
// host, a co-host, the owner or a moderator), and a member storage key names
// them. Every read renders the row's opaque reference.

const UPLOADER_ID = '11111111-2222-4333-8444-555555555555';
const EVENT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const COMMUNITY_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const EVENT_COVER_KEY = `event-covers/${UPLOADER_ID}/cccccccc-3333-4333-8333-cccccccccccc.webp`;
const COMMUNITY_COVER_KEY = `community-covers/${UPLOADER_ID}/dddddddd-4444-4444-8444-dddddddddddd.webp`;
const COMMUNITY_AVATAR_KEY = `community-avatars/${UPLOADER_ID}/ffffffff-6666-4666-8666-ffffffffffff.webp`;

function makeEvent(coverImageUrl: string | null): Event {
  // Only the columns `toEventSummary` reads, as in
  // `event-summary-run-by.spec.ts`.
  return {
    id: EVENT_ID,
    slug: 'queer-history-walk',
    title: 'Queer history walk',
    startAt: new Date('2026-11-01T10:00:00.000Z'),
    endAt: null,
    timezone: 'Europe/Lisbon',
    venue: null,
    isOnline: false,
    coverImageUrl,
    visibility: 'public',
    status: 'published',
    capacity: null,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    description: 'A walk',
    communityId: null,
    listingId: null,
    neighbourhood: null,
    eventType: null,
    gatheringFamily: null,
    formatDetails: null,
    cost: null,
    themes: [],
    costKind: null,
    seriesId: null,
    seriesIndex: null,
  } as unknown as Event;
}

function makeCommunity(coverImageUrl: string | null): Community {
  // Only the columns `toCommunityCard` reads.
  return {
    id: COMMUNITY_ID,
    slug: 'trans-hiking-lisboa',
    name: 'Trans Hiking Lisboa',
    type: 'social',
    tagline: 'Walks on weekends',
    accessTier: 'public',
    ref: 'QPC-0001',
    coverImageUrl,
    tags: [],
    avatarImageUrl: COMMUNITY_AVATAR_KEY,
    city: 'Lisboa',
    features: [],
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    area: null,
    isOnline: false,
    languages: [],
    nowReading: null,
  } as unknown as Community;
}

const STATS = { memberCount: 3, activeThisWeek: 1, postsThisWeek: 2 };

describe('cover references on event and community reads', () => {
  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  it('renders an event cover by the event reference', () => {
    const summary = toEventSummary(makeEvent(EVENT_COVER_KEY), 0, null, false);
    expect(summary.coverImageUrl).toBe(
      `https://api.test/files/events/${EVENT_ID}/cover?v=${mediaReferenceVersion(EVENT_COVER_KEY, `events/${EVENT_ID}/cover`)}`,
    );
    expect(JSON.stringify(summary)).not.toContain(UPLOADER_ID);
  });

  it('passes an external event cover through', () => {
    const summary = toEventSummary(
      makeEvent('https://images.example.com/walk.jpg'),
      0,
      null,
      false,
    );
    expect(summary.coverImageUrl).toBe('https://images.example.com/walk.jpg');
  });

  it('renders a community cover by the community reference', () => {
    const card = toCommunityCard(
      makeCommunity(COMMUNITY_COVER_KEY),
      STATS,
      null,
    );
    expect(card.coverImageUrl).toBe(
      `https://api.test/files/communities/${COMMUNITY_ID}/cover?v=${mediaReferenceVersion(COMMUNITY_COVER_KEY, `communities/${COMMUNITY_ID}/cover`)}`,
    );
    expect(JSON.stringify(card)).not.toContain(UPLOADER_ID);
  });

  it('keeps an empty community cover empty', () => {
    expect(
      toCommunityCard(makeCommunity(null), STATS, null).coverImageUrl,
    ).toBe(null);
  });

  it('renders a community avatar by the community reference', () => {
    const card = toCommunityCard(makeCommunity(null), STATS, null);
    expect(card.avatarImageUrl).toBe(
      `https://api.test/files/communities/${COMMUNITY_ID}/avatar?v=${mediaReferenceVersion(COMMUNITY_AVATAR_KEY, `communities/${COMMUNITY_ID}/avatar`)}`,
    );
  });

  // The homepage spotlight.
  it('renders landing community and event covers by reference', () => {
    const feature = { id: 'feature-1', copy: {} } as unknown as LandingFeature;
    const community = toLandingCommunityFeatureDTO(
      feature,
      makeCommunity(COMMUNITY_COVER_KEY),
      3,
      null,
      [],
    );
    expect(community.coverImageUrl).toBe(
      `https://api.test/files/communities/${COMMUNITY_ID}/cover?v=${mediaReferenceVersion(COMMUNITY_COVER_KEY, `communities/${COMMUNITY_ID}/cover`)}`,
    );
    const gathering = toLandingGatheringFeatureDTO(
      feature,
      makeEvent(EVENT_COVER_KEY),
    );
    expect(gathering.coverImageUrl).toBe(
      `https://api.test/files/events/${EVENT_ID}/cover?v=${mediaReferenceVersion(EVENT_COVER_KEY, `events/${EVENT_ID}/cover`)}`,
    );
  });

  it('renders a feed event card cover by reference', () => {
    const item = eventToFeedItem(makeEvent(EVENT_COVER_KEY), null);
    expect(item.imageUrl).toBe(
      `https://api.test/files/events/${EVENT_ID}/cover?v=${mediaReferenceVersion(EVENT_COVER_KEY, `events/${EVENT_ID}/cover`)}`,
    );
  });

  it("renders an invitee's event cover by reference", () => {
    const invite = {
      id: 'invite-1',
      status: 'pending',
      createdAt: new Date('2026-10-02T10:00:00.000Z'),
    } as unknown as EventInvite;
    const view = toPendingEventInviteView(
      invite,
      makeEvent(EVENT_COVER_KEY),
      undefined,
    );
    expect(view.event?.coverImageUrl).toBe(
      `https://api.test/files/events/${EVENT_ID}/cover?v=${mediaReferenceVersion(EVENT_COVER_KEY, `events/${EVENT_ID}/cover`)}`,
    );
  });
});
