import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CardTokenService } from '../membership-cards/card-token.service';
import { CommunityCard } from '../membership-cards/entities/community-card.entity';
import {
  MembershipCard,
  MembershipCardStatus,
} from '../membership-cards/entities/membership-card.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import {
  CHECK_IN_CARD_UNREADABLE,
  CHECK_IN_MAYBE,
  CHECK_IN_MEMBER_NOT_FOUND,
  CHECK_IN_NOT_ON_GUEST_LIST,
  CHECK_IN_WAITLISTED,
} from './event-check-in-codes';
import { EventCheckInService } from './event-check-in.service';
import { EventsService } from './events.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';

/**
 * The event door reads a scanned membership card through the same
 * `effectiveCardStatus` as `/cards/verify`, holder account included: a card
 * whose holder is suspended, paused, or inside the erasure grace period checks
 * nobody in.
 */
describe('EventCheckInService card check-in', () => {
  const HOST_ID = 'host-1';
  const MEMBER_ID = 'member-1';

  let profiles: { findOne: jest.Mock };
  let rsvps: { findOne: jest.Mock; save: jest.Mock };
  let service: EventCheckInService;

  const holderProfile = (status: UserStatus) => ({
    userId: MEMBER_ID,
    slug: 'mara',
    firstName: 'Mara',
    lastName: 'S',
    avatarUrl: null,
    photoVisible: true,
    user: { status },
  });

  beforeEach(() => {
    const events = {
      findOne: jest.fn().mockResolvedValue({
        id: 'event-1',
        slug: 'supper',
        hostId: HOST_ID,
        startAt: new Date(),
        endAt: null,
      }),
    };
    const cohosts = { exists: jest.fn().mockResolvedValue(false) };
    rsvps = {
      findOne: jest.fn().mockResolvedValue({
        id: 'rsvp-1',
        eventId: 'event-1',
        userId: MEMBER_ID,
        status: RsvpStatus.Going,
        checkedInAt: null,
      }),
      save: jest.fn((row: EventRsvp) => Promise.resolve(row)),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(holderProfile(UserStatus.Active)),
    };
    const cards = {
      findOne: jest.fn().mockResolvedValue({
        id: 'card-1',
        programId: 'prog-1',
        userId: MEMBER_ID,
        status: MembershipCardStatus.Active,
        expiresAt: null,
        codeVersion: 1,
      }),
    };
    const cardPrograms = {
      findOne: jest.fn().mockResolvedValue({
        id: 'prog-1',
        issuerId: 'com-1',
        isEnabled: true,
      }),
    };
    const communities = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'com-1', frozenAt: null, archivedAt: null }),
    };
    const cardTokens = {
      verify: jest.fn().mockReturnValue({ cardId: 'card-1', codeVersion: 1 }),
    };
    const eventsService = {
      rosterCounts: jest.fn().mockResolvedValue({
        goingCount: 1,
        seatsTaken: 1,
        waitlistCount: 0,
        checkedInCount: 1,
      }),
    };
    const config = {
      get: jest.fn((_key: string, fallback?: number) => fallback ?? 30),
    };

    service = new EventCheckInService(
      config as unknown as ConfigService,
      events as unknown as Repository<Event>,
      cohosts as unknown as Repository<EventCohost>,
      rsvps as unknown as Repository<EventRsvp>,
      profiles as unknown as Repository<Profile>,
      cards as unknown as Repository<MembershipCard>,
      cardPrograms as unknown as Repository<CommunityCard>,
      communities as unknown as Repository<Community>,
      cardTokens as unknown as CardTokenService,
      eventsService as unknown as EventsService,
    );
  });

  it('checks in the holder of a good card whose account is active', async () => {
    await service.checkIn('supper', HOST_ID, { cardToken: 'signed.code' });
    expect(rsvps.save).toHaveBeenCalledTimes(1);
  });

  it('joins the holder account when reading the card holder', async () => {
    await service.checkIn('supper', HOST_ID, { cardToken: 'signed.code' });
    expect(profiles.findOne).toHaveBeenCalledWith({
      where: { userId: MEMBER_ID },
      relations: { user: true },
    });
  });

  it.each([UserStatus.Suspended, UserStatus.Deactivated])(
    'refuses the card of a holder whose account is %s, and writes nothing',
    async (holderStatus) => {
      profiles.findOne.mockResolvedValue(holderProfile(holderStatus));
      const outcome = service.checkIn('supper', HOST_ID, {
        cardToken: 'signed.code',
      });
      await expect(outcome).rejects.toBeInstanceOf(BadRequestException);
      await expect(outcome).rejects.toMatchObject({
        response: { statusCode: 400, code: CHECK_IN_CARD_UNREADABLE },
      });
      expect(rsvps.findOne).not.toHaveBeenCalled();
      expect(rsvps.save).not.toHaveBeenCalled();
    },
  );
});

/**
 * The by-name branch reads the same holder account status the card branch
 * does, so a suspended, deactivated or erasure-grace member cannot be waved
 * through by a tap on their guest-list row while their own card is refused at
 * the same door. The refusal is the same generic "Member not found" an
 * unmatched slug already gets: an event host is another member, and the
 * platform does not tell one member that another was suspended or is
 * deactivating their account.
 */
describe('EventCheckInService check-in by name', () => {
  const HOST_ID = 'host-1';
  const MEMBER_ID = 'member-1';

  let profiles: { findOne: jest.Mock };
  let rsvps: { findOne: jest.Mock; save: jest.Mock };
  let service: EventCheckInService;

  const holderProfile = (status: UserStatus) => ({
    userId: MEMBER_ID,
    slug: 'mara',
    firstName: 'Mara',
    lastName: 'S',
    user: { status },
  });

  beforeEach(() => {
    const events = {
      findOne: jest.fn().mockResolvedValue({
        id: 'event-1',
        slug: 'supper',
        hostId: HOST_ID,
        startAt: new Date(),
        endAt: null,
      }),
    };
    const cohosts = { exists: jest.fn().mockResolvedValue(false) };
    rsvps = {
      findOne: jest.fn().mockResolvedValue({
        id: 'rsvp-1',
        eventId: 'event-1',
        userId: MEMBER_ID,
        status: RsvpStatus.Going,
        checkedInAt: null,
      }),
      save: jest.fn((row: EventRsvp) => Promise.resolve(row)),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(holderProfile(UserStatus.Active)),
    };
    const cards = { findOne: jest.fn() };
    const cardPrograms = { findOne: jest.fn() };
    const communities = { findOne: jest.fn() };
    const cardTokens = { verify: jest.fn() };
    const eventsService = {
      rosterCounts: jest.fn().mockResolvedValue({
        goingCount: 1,
        seatsTaken: 1,
        waitlistCount: 0,
        checkedInCount: 1,
      }),
    };
    const config = {
      get: jest.fn((_key: string, fallback?: number) => fallback ?? 30),
    };

    service = new EventCheckInService(
      config as unknown as ConfigService,
      events as unknown as Repository<Event>,
      cohosts as unknown as Repository<EventCohost>,
      rsvps as unknown as Repository<EventRsvp>,
      profiles as unknown as Repository<Profile>,
      cards as unknown as Repository<MembershipCard>,
      cardPrograms as unknown as Repository<CommunityCard>,
      communities as unknown as Repository<Community>,
      cardTokens as unknown as CardTokenService,
      eventsService as unknown as EventsService,
    );
  });

  it('checks in a named guest whose account is active', async () => {
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(rsvps.save).toHaveBeenCalledTimes(1);
  });

  it('reads the holder account when resolving a member slug for check-in', async () => {
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(profiles.findOne).toHaveBeenCalledWith({
      where: { slug: 'mara' },
      relations: { user: true },
    });
  });

  it.each([UserStatus.Suspended, UserStatus.Deactivated])(
    'refuses a named guest whose account is %s, with the same message and code an unmatched slug gets, and writes nothing',
    async (holderStatus) => {
      profiles.findOne.mockResolvedValue(holderProfile(holderStatus));
      const outcome = service.checkIn('supper', HOST_ID, {
        memberSlug: 'mara',
      });
      await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
      await expect(outcome).rejects.toThrow('Member not found');
      await expect(outcome).rejects.toMatchObject({
        response: { statusCode: 404, code: CHECK_IN_MEMBER_NOT_FOUND },
      });
      expect(rsvps.findOne).not.toHaveBeenCalled();
      expect(rsvps.save).not.toHaveBeenCalled();
    },
  );

  it('refuses an unmatched slug with the identical exception, message and code, so a non-active account is indistinguishable from an unknown one', async () => {
    profiles.findOne.mockResolvedValue(null);
    const outcome = service.checkIn('supper', HOST_ID, {
      memberSlug: 'nobody',
    });
    await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
    await expect(outcome).rejects.toThrow('Member not found');
    await expect(outcome).rejects.toMatchObject({
      response: { statusCode: 404, code: CHECK_IN_MEMBER_NOT_FOUND },
    });
    expect(rsvps.findOne).not.toHaveBeenCalled();
    expect(rsvps.save).not.toHaveBeenCalled();
  });

  it.each([UserStatus.Suspended, UserStatus.Deactivated])(
    'still undoes a check-in by name for a member whose account is now %s',
    async (holderStatus) => {
      profiles.findOne.mockResolvedValue(holderProfile(holderStatus));
      rsvps.findOne.mockResolvedValue({
        id: 'rsvp-1',
        eventId: 'event-1',
        userId: MEMBER_ID,
        status: RsvpStatus.Going,
        checkedInAt: new Date(),
      });
      await service.undoCheckIn('supper', HOST_ID, 'mara');
      expect(rsvps.save).toHaveBeenCalledWith(
        expect.objectContaining({ checkedInAt: null }),
      );
    },
  );
});

/**
 * The remaining coded refusals in `checkIn`/`undoCheckIn`: no RSVP (or a
 * cancelled one), a waitlisted RSVP, a "maybe" RSVP, and undo's own
 * `resolveByMemberSlug` throw for an unmatched slug. Each carries the
 * `{ statusCode, error, code, message }` shape `EVENT_ATTENDANCE_WINDOW_CLOSED_CODE`
 * already uses, so a client can branch on `code` alone.
 */
describe('EventCheckInService coded RSVP-state refusals', () => {
  const HOST_ID = 'host-1';
  const MEMBER_ID = 'member-1';

  let profiles: { findOne: jest.Mock };
  let rsvps: { findOne: jest.Mock; save: jest.Mock };
  let service: EventCheckInService;

  beforeEach(() => {
    const events = {
      findOne: jest.fn().mockResolvedValue({
        id: 'event-1',
        slug: 'supper',
        hostId: HOST_ID,
        startAt: new Date(),
        endAt: null,
      }),
    };
    const cohosts = { exists: jest.fn().mockResolvedValue(false) };
    rsvps = {
      findOne: jest.fn(),
      save: jest.fn((row: EventRsvp) => Promise.resolve(row)),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue({
        userId: MEMBER_ID,
        slug: 'mara',
        user: { status: UserStatus.Active },
      }),
    };
    const cards = { findOne: jest.fn() };
    const cardPrograms = { findOne: jest.fn() };
    const communities = { findOne: jest.fn() };
    const cardTokens = { verify: jest.fn() };
    const eventsService = { rosterCounts: jest.fn() };
    const config = {
      get: jest.fn((_key: string, fallback?: number) => fallback ?? 30),
    };

    service = new EventCheckInService(
      config as unknown as ConfigService,
      events as unknown as Repository<Event>,
      cohosts as unknown as Repository<EventCohost>,
      rsvps as unknown as Repository<EventRsvp>,
      profiles as unknown as Repository<Profile>,
      cards as unknown as Repository<MembershipCard>,
      cardPrograms as unknown as Repository<CommunityCard>,
      communities as unknown as Repository<Community>,
      cardTokens as unknown as CardTokenService,
      eventsService as unknown as EventsService,
    );
  });

  it.each([undefined, RsvpStatus.Cancelled])(
    'carries CHECK_IN_NOT_ON_GUEST_LIST when checking in a member with no RSVP or a cancelled one',
    async (rsvpStatus) => {
      rsvps.findOne.mockResolvedValue(
        rsvpStatus === undefined ? null : { status: rsvpStatus },
      );
      const outcome = service.checkIn('supper', HOST_ID, {
        memberSlug: 'mara',
      });
      await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
      await expect(outcome).rejects.toThrow(
        'That member is not on the guest list',
      );
      await expect(outcome).rejects.toMatchObject({
        response: { statusCode: 404, code: CHECK_IN_NOT_ON_GUEST_LIST },
      });
      expect(rsvps.save).not.toHaveBeenCalled();
    },
  );

  it('carries CHECK_IN_NOT_ON_GUEST_LIST when undoing a member with no RSVP', async () => {
    rsvps.findOne.mockResolvedValue(null);
    const outcome = service.undoCheckIn('supper', HOST_ID, 'mara');
    await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
    await expect(outcome).rejects.toThrow(
      'That member is not on the guest list',
    );
    await expect(outcome).rejects.toMatchObject({
      response: { statusCode: 404, code: CHECK_IN_NOT_ON_GUEST_LIST },
    });
    expect(rsvps.save).not.toHaveBeenCalled();
  });

  it('carries CHECK_IN_WAITLISTED for a waitlisted RSVP, and writes nothing', async () => {
    rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Waitlisted });
    const outcome = service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    await expect(outcome).rejects.toBeInstanceOf(BadRequestException);
    await expect(outcome).rejects.toThrow(
      'That member is on the waitlist. Promote them first, then check them in.',
    );
    await expect(outcome).rejects.toMatchObject({
      response: { statusCode: 400, code: CHECK_IN_WAITLISTED },
    });
    expect(rsvps.save).not.toHaveBeenCalled();
  });

  it('carries CHECK_IN_MAYBE for a "maybe" RSVP, and writes nothing', async () => {
    rsvps.findOne.mockResolvedValue({ status: RsvpStatus.Maybe });
    const outcome = service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    await expect(outcome).rejects.toBeInstanceOf(BadRequestException);
    await expect(outcome).rejects.toThrow(
      'That member answered maybe and has no seat yet',
    );
    await expect(outcome).rejects.toMatchObject({
      response: { statusCode: 400, code: CHECK_IN_MAYBE },
    });
    expect(rsvps.save).not.toHaveBeenCalled();
  });

  it('carries CHECK_IN_MEMBER_NOT_FOUND when undoing an unmatched slug, the same code the checkIn-by-name resolver uses', async () => {
    profiles.findOne.mockResolvedValue(null);
    const outcome = service.undoCheckIn('supper', HOST_ID, 'nobody');
    await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
    await expect(outcome).rejects.toThrow('Member not found');
    await expect(outcome).rejects.toMatchObject({
      response: { statusCode: 404, code: CHECK_IN_MEMBER_NOT_FOUND },
    });
    expect(rsvps.findOne).not.toHaveBeenCalled();
    expect(rsvps.save).not.toHaveBeenCalled();
  });
});
