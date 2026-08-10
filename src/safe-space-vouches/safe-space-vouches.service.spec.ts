import { Repository } from 'typeorm';
import {
  Listing,
  ListingStatus,
  SafeSpaceStatus,
} from '../listings/entities/listing.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SafeSpaceMemberVouch } from './entities/safe-space-vouch.entity';
import { SafeSpaceVouchesService } from './safe-space-vouches.service';

/**
 * The load-bearing behaviour SP4 adds: `createVouch` — which used to notify NO
 * ONE — now tells the space's listing OWNER, and never the voucher themself.
 */
function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    ownerId: 'owner-1',
    name: 'Casa Aberta',
    slug: 'casa-aberta',
    status: ListingStatus.Live,
    safeSpaceStatus: SafeSpaceStatus.Verified,
    ...overrides,
  } as Listing;
}

function build(listing: Listing) {
  const memberVouches = {
    findOne: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(1),
  };
  const listings = {
    findOne: jest.fn().mockResolvedValue(listing),
  };
  const notifications = {
    create: jest.fn().mockResolvedValue(null),
  };
  const service = new SafeSpaceVouchesService(
    memberVouches as unknown as Repository<SafeSpaceMemberVouch>,
    listings as unknown as Repository<Listing>,
    notifications as unknown as NotificationsService,
  );
  return { service, memberVouches, listings, notifications };
}

describe('SafeSpaceVouchesService.createVouch', () => {
  it('notifies the space OWNER with a SafeSpaceVouch, and never the voucher', async () => {
    const { service, notifications } = build(makeListing());

    await service.createVouch('voucher-1', 'casa-aberta');

    expect(notifications.create).toHaveBeenCalledTimes(1);
    const [recipientId, type, payload, actorId] = notifications.create.mock
      .calls[0] as [string, NotificationType, Record<string, unknown>, string];
    // The OWNER is the recipient — not the voucher.
    expect(recipientId).toBe('owner-1');
    expect(recipientId).not.toBe('voucher-1');
    expect(type).toBe(NotificationType.SafeSpaceVouch);
    // The voucher is the actor (so a blocked/muted voucher is filtered) and is
    // named in the payload for a non-anonymous vouch.
    expect(actorId).toBe('voucher-1');
    expect(payload).toEqual({
      spaceId: 'listing-1',
      spaceName: 'Casa Aberta',
      spaceSlug: 'casa-aberta',
      voucherId: 'voucher-1',
    });
  });

  it('omits voucherId from the payload for an anonymous vouch (but keeps it as the actorId)', async () => {
    const { service, notifications } = build(makeListing());

    await service.createVouch('voucher-1', 'casa-aberta', { anonymous: true });

    const [, , payload, actorId] = notifications.create.mock.calls[0] as [
      string,
      NotificationType,
      Record<string, unknown>,
      string,
    ];
    expect(payload).not.toHaveProperty('voucherId');
    // Block/mute gate is still fed the voucher's id even when anonymous.
    expect(actorId).toBe('voucher-1');
  });

  it('does not notify when the owner vouches for their own space', async () => {
    const { service, notifications } = build(
      makeListing({ ownerId: 'self-1' }),
    );

    await service.createVouch('self-1', 'casa-aberta');

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
