import { EventStatus, EventVisibility } from '../events/entities/event.entity';
import {
  flashDayEventSlugOf,
  isLinkableFlashDayEvent,
  toFlashDayEventRef,
} from './flash-day-event-links';

describe('flash day event links', () => {
  describe('toFlashDayEventRef', () => {
    it('maps an event to exactly the eight public fields', () => {
      const eventRow = {
        slug: 'flash-day-arroios',
        title: 'Flash Day at Arroios',
        startAt: new Date('2026-11-14T11:00:00.000Z'),
        endAt: new Date('2026-11-14T19:00:00.000Z'),
        venue: 'Casa do Bairro',
        neighbourhood: 'Arroios',
        isOnline: false,
        coverImageUrl: 'https://images.example.org/flash-day.jpg',
        // The exact door: present on the row, kept off the ref.
        address: 'Rua Secreta 1',
        arrivalNotes: 'ring twice',
        hostId: 'host-1',
      };

      const ref = toFlashDayEventRef(eventRow);

      expect(Object.keys(ref)).toEqual([
        'slug',
        'title',
        'startsAt',
        'endsAt',
        'venue',
        'neighbourhood',
        'isOnline',
        'imageUrl',
      ]);
      expect(ref).toEqual({
        slug: 'flash-day-arroios',
        title: 'Flash Day at Arroios',
        startsAt: '2026-11-14T11:00:00.000Z',
        endsAt: '2026-11-14T19:00:00.000Z',
        venue: 'Casa do Bairro',
        neighbourhood: 'Arroios',
        isOnline: false,
        imageUrl: 'https://images.example.org/flash-day.jpg',
      });
      const serializedRef = JSON.stringify(ref);
      expect(serializedRef).not.toContain('Rua Secreta 1');
      expect(serializedRef).not.toContain('ring twice');
      expect(serializedRef).not.toContain('host-1');
    });

    it('maps a missing end, venue, neighbourhood and cover to null', () => {
      const ref = toFlashDayEventRef({
        slug: 'online-flash-day',
        title: 'Online Flash Day',
        startAt: new Date('2026-12-01T18:00:00.000Z'),
        endAt: null,
        venue: null,
        neighbourhood: null,
        isOnline: true,
        coverImageUrl: null,
      });

      expect(ref).toEqual({
        slug: 'online-flash-day',
        title: 'Online Flash Day',
        startsAt: '2026-12-01T18:00:00.000Z',
        endsAt: null,
        venue: null,
        neighbourhood: null,
        isOnline: true,
        imageUrl: null,
      });
    });
  });

  describe('flashDayEventSlugOf', () => {
    it('reads a blank or missing eventSlug as no link', () => {
      expect(flashDayEventSlugOf(null)).toBeNull();
      expect(flashDayEventSlugOf(undefined)).toBeNull();
      expect(flashDayEventSlugOf({})).toBeNull();
      expect(flashDayEventSlugOf({ flashDay: null })).toBeNull();
      expect(flashDayEventSlugOf({ flashDay: {} })).toBeNull();
      expect(flashDayEventSlugOf({ flashDay: { eventSlug: '' } })).toBeNull();
      expect(
        flashDayEventSlugOf({ flashDay: { eventSlug: '   ' } }),
      ).toBeNull();
      expect(
        flashDayEventSlugOf({ flashDay: { cause: 'Trans healthcare fund' } }),
      ).toBeNull();
    });

    it('trims a stored eventSlug', () => {
      expect(
        flashDayEventSlugOf({
          flashDay: { eventSlug: '  flash-day-arroios ' },
        }),
      ).toBe('flash-day-arroios');
    });
  });

  describe('isLinkableFlashDayEvent', () => {
    it('links only published public events', () => {
      expect(
        isLinkableFlashDayEvent({
          status: EventStatus.Published,
          visibility: EventVisibility.Public,
        }),
      ).toBe(true);
      for (const visibility of [
        EventVisibility.Members,
        EventVisibility.Network,
        EventVisibility.InviteOnly,
      ]) {
        expect(
          isLinkableFlashDayEvent({
            status: EventStatus.Published,
            visibility,
          }),
        ).toBe(false);
      }
      for (const status of [EventStatus.Draft, EventStatus.Cancelled]) {
        expect(
          isLinkableFlashDayEvent({
            status,
            visibility: EventVisibility.Public,
          }),
        ).toBe(false);
      }
    });
  });
});
