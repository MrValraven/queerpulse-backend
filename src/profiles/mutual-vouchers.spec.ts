import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import { VouchService } from '../vouch/vouch.service';
import { ProfilesService } from './profiles.service';

/**
 * The viewer-relative "members you know vouched for them" count (SOC-15).
 *
 * `loadMutualVoucherCount` is private, so these drive it the way the profile
 * read does, through a bare instance with only the two collaborators it
 * touches. Nothing else on `ProfilesService` is exercised, which keeps this
 * spec unaffected by the rest of a 1300-line service.
 */
interface Harness {
  countFor: (profile: Profile, viewerUserId: string) => Promise<number | null>;
  getNamedVoucherIds: jest.Mock;
  acceptedConnectionsAmong: jest.Mock;
}

function buildHarness(): Harness {
  const getNamedVoucherIds = jest.fn().mockResolvedValue([]);
  const acceptedConnectionsAmong = jest.fn().mockResolvedValue(new Set());
  const vouchService = { getNamedVoucherIds } as unknown as VouchService;
  const connectionsService = {
    acceptedConnectionsAmong,
  } as unknown as ConnectionsService;
  // A bare instance with the two collaborators this method reads injected by
  // name. `Object.create` skips the 20-argument constructor, so adding an
  // unrelated dependency to `ProfilesService` never breaks this spec.
  const service = Object.create(ProfilesService.prototype) as Record<
    string,
    unknown
  >;
  service.vouchService = vouchService;
  service.connectionsService = connectionsService;
  const callable = service as unknown as {
    loadMutualVoucherCount: (
      profile: Profile,
      viewerUserId: string,
    ) => Promise<number | null>;
  };
  return {
    countFor: (profile, viewerUserId) =>
      callable.loadMutualVoucherCount.call(service, profile, viewerUserId),
    getNamedVoucherIds,
    acceptedConnectionsAmong,
  };
}

const memberProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    userId: 'subject-1',
    slug: 'subject',
    vouchersVisible: true,
    ...overrides,
  }) as Profile;

describe('ProfilesService mutual voucher count: the privacy gate', () => {
  it('returns null when the member has hidden their voucher roster', async () => {
    const harness = buildHarness();
    harness.getNamedVoucherIds.mockResolvedValue(['voucher-1', 'voucher-2']);
    harness.acceptedConnectionsAmong.mockResolvedValue(new Set(['voucher-1']));

    const count = await harness.countFor(
      memberProfile({ vouchersVisible: false }),
      'viewer-1',
    );

    // A viewer-relative count over a set the viewer knows BY NAME is a partial
    // roster: with three connections and a count of one, the viewer has
    // narrowed "who vouched for them" to three people, often to one. A member
    // who hid their roster hid it from this read too.
    expect(count).toBeNull();
  });

  it('does not even read the voucher graph when the roster is hidden', async () => {
    const harness = buildHarness();

    await harness.countFor(
      memberProfile({ vouchersVisible: false }),
      'viewer-1',
    );

    // The gate is before the read, not a filter after it, so no voucher id
    // ever reaches this code path for a member who opted out.
    expect(harness.getNamedVoucherIds).not.toHaveBeenCalled();
    expect(harness.acceptedConnectionsAmong).not.toHaveBeenCalled();
  });

  it('returns null rather than 0 for a hidden roster, so 0 always means zero', async () => {
    const harness = buildHarness();
    const hidden = await harness.countFor(
      memberProfile({ vouchersVisible: false }),
      'viewer-1',
    );
    harness.getNamedVoucherIds.mockResolvedValue(['voucher-1']);
    harness.acceptedConnectionsAmong.mockResolvedValue(new Set());
    const genuinelyNone = await harness.countFor(memberProfile(), 'viewer-1');

    expect(hidden).toBeNull();
    expect(genuinelyNone).toBe(0);
  });

  it('returns null when the viewer is the member', async () => {
    const harness = buildHarness();

    const count = await harness.countFor(
      memberProfile({ userId: 'viewer-1' }),
      'viewer-1',
    );

    expect(count).toBeNull();
    expect(harness.getNamedVoucherIds).not.toHaveBeenCalled();
  });
});

describe('ProfilesService mutual voucher count: the count itself', () => {
  it('counts the vouchers the viewer is accepted-connected to', async () => {
    const harness = buildHarness();
    harness.getNamedVoucherIds.mockResolvedValue([
      'voucher-1',
      'voucher-2',
      'voucher-3',
    ]);
    harness.acceptedConnectionsAmong.mockResolvedValue(
      new Set(['voucher-1', 'voucher-3']),
    );

    await expect(harness.countFor(memberProfile(), 'viewer-1')).resolves.toBe(
      2,
    );
    expect(harness.acceptedConnectionsAmong).toHaveBeenCalledWith('viewer-1', [
      'voucher-1',
      'voucher-2',
      'voucher-3',
    ]);
  });

  it('reads the voucher ids from the vouchee, never from the viewer', async () => {
    const harness = buildHarness();
    harness.getNamedVoucherIds.mockResolvedValue(['voucher-1']);

    await harness.countFor(memberProfile({ userId: 'subject-1' }), 'viewer-1');

    expect(harness.getNamedVoucherIds).toHaveBeenCalledWith('subject-1');
  });

  it('is 0 with no vouchers at all, without a connections query', async () => {
    const harness = buildHarness();
    harness.getNamedVoucherIds.mockResolvedValue([]);

    await expect(harness.countFor(memberProfile(), 'viewer-1')).resolves.toBe(
      0,
    );
    expect(harness.acceptedConnectionsAmong).not.toHaveBeenCalled();
  });

  it('runs exactly two batched reads, never one query per voucher', async () => {
    const harness = buildHarness();
    harness.getNamedVoucherIds.mockResolvedValue(
      Array.from({ length: 40 }, (_unused, index) => `voucher-${index}`),
    );
    harness.acceptedConnectionsAmong.mockResolvedValue(new Set(['voucher-7']));

    await harness.countFor(memberProfile(), 'viewer-1');

    expect(harness.getNamedVoucherIds).toHaveBeenCalledTimes(1);
    expect(harness.acceptedConnectionsAmong).toHaveBeenCalledTimes(1);
  });
});
