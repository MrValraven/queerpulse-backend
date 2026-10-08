import { Event } from './entities/event.entity';
import { toEventSummary } from './event-response';

const walk = {
  id: 'event-1',
  slug: 'queer-history-walk',
  title: 'Queer history walk',
  startAt: new Date('2026-11-01T10:00:00.000Z'),
  endAt: null,
  timezone: 'Europe/Lisbon',
  venue: null,
  isOnline: false,
  coverImageUrl: null,
  visibility: 'public',
  status: 'published',
  capacity: null,
  communityId: null,
  listingId: null,
  runByListingId: 'listing-walk',
  neighbourhood: 'Santa Maria Maior',
  eventType: null,
  gatheringFamily: null,
  formatDetails: null,
  cost: null,
  themes: [],
  costKind: null,
  seriesId: null,
  seriesIndex: null,
} as unknown as Event;

describe('toEventSummary run-by line', () => {
  it('carries the run-by line its caller resolved', () => {
    const summary = toEventSummary(
      walk,
      3,
      null,
      false,
      new Map(),
      null,
      undefined,
      3,
      { ref: 'QPL-2026-0042', slug: 'lisboa-a-pe', name: 'Lisboa a Pé' },
    );

    expect(summary.runByListing).toEqual({
      ref: 'QPL-2026-0042',
      slug: 'lisboa-a-pe',
      name: 'Lisboa a Pé',
    });
  });

  it('reads null when the caller resolved none', () => {
    expect(toEventSummary(walk, 0, null, false).runByListing).toBeNull();
  });

  it('never carries the raw listing id', () => {
    expect(toEventSummary(walk, 0, null, false)).not.toHaveProperty(
      'runByListingId',
    );
  });
});
