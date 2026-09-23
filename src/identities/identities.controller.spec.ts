import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { IdentityKind } from './entities/identity.entity';
import { IdentitiesController } from './identities.controller';

function makeAttributionSettings() {
  return {
    getAttribution: jest.fn(),
    updateOwnerSwitch: jest.fn(),
    updateOwnStaffPreference: jest.fn(),
  };
}

/**
 * Task 15: `GET /identities/mailboxes`, the list the header mailbox switcher
 * reads. The controller only forwards the caller's own user id; which
 * mailboxes exist and what they count lives in
 * `IdentitiesService.listMailboxesFor` (see `list-mailboxes.spec.ts`).
 */
describe('GET /identities/mailboxes', () => {
  it('lists the member profile mailbox first, then the rest', async () => {
    const service = {
      listMailboxesFor: jest.fn().mockResolvedValue([
        {
          identityId: 'profile-identity',
          kind: IdentityKind.Profile,
          displayName: 'Tiago',
          handle: 'tiago',
          avatarUrl: null,
          unreadCount: 3,
          isOwner: true,
        },
        {
          identityId: 'cafe-identity',
          kind: IdentityKind.Listing,
          displayName: 'Cafe Lisboa',
          handle: 'cafe-lisboa',
          avatarUrl: null,
          unreadCount: 2,
          isOwner: false,
        },
      ]),
    };
    const controller = new IdentitiesController(
      service as never,
      makeAttributionSettings() as never,
    );

    const result = await controller.mailboxes({
      userId: 'tiago-user',
    } as never);

    expect(result[0]!.kind).toBe(IdentityKind.Profile);
    expect(service.listMailboxesFor).toHaveBeenCalledWith('tiago-user');
  });

  it('returns only the profile mailbox for a member who staffs nothing', async () => {
    const service = {
      listMailboxesFor: jest.fn().mockResolvedValue([
        {
          identityId: 'profile-identity',
          kind: IdentityKind.Profile,
          displayName: 'Plain Member',
          handle: 'plain',
          avatarUrl: null,
          unreadCount: 0,
          isOwner: true,
        },
      ]),
    };
    const controller = new IdentitiesController(
      service as never,
      makeAttributionSettings() as never,
    );

    await expect(
      controller.mailboxes({ userId: 'plain-user' } as never),
    ).resolves.toHaveLength(1);
  });

  it('is guarded by the ordinary authenticated-member guard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      IdentitiesController,
    ) as unknown[];

    expect(guards).toContain(ActiveMemberGuard);
  });
});

/**
 * Task 20: the three attribution routes are thin plumbing onto
 * `IdentityAttributionSettingsService`. Every refusal and ownership rule
 * lives there instead (see `identity-attribution-settings.service.spec.ts`).
 */
describe('GET /identities/:identityId/attribution', () => {
  it('forwards the caller and the identity id, and returns the service answer', async () => {
    const attributionSettings = makeAttributionSettings();
    const answer = {
      shouldShowStaffNames: true,
      shouldAllowMyName: true,
      isOwner: false,
    };
    attributionSettings.getAttribution.mockResolvedValue(answer);
    const controller = new IdentitiesController(
      {} as never,
      attributionSettings as never,
    );

    const result = await controller.attribution(
      { userId: 'co-manager-user' } as never,
      'cafe-identity',
    );

    expect(attributionSettings.getAttribution).toHaveBeenCalledWith(
      'co-manager-user',
      'cafe-identity',
    );
    expect(result).toBe(answer);
  });
});

describe('PATCH /identities/:identityId/attribution', () => {
  it("forwards the caller, the identity id and the body's switch", async () => {
    const attributionSettings = makeAttributionSettings();
    const answer = {
      shouldShowStaffNames: false,
      shouldAllowMyName: true,
      isOwner: true,
    };
    attributionSettings.updateOwnerSwitch.mockResolvedValue(answer);
    const controller = new IdentitiesController(
      {} as never,
      attributionSettings as never,
    );

    const result = await controller.updateAttribution(
      { userId: 'owner-user' } as never,
      'cafe-identity',
      { shouldShowStaffNames: false },
    );

    expect(attributionSettings.updateOwnerSwitch).toHaveBeenCalledWith(
      'owner-user',
      'cafe-identity',
      false,
    );
    expect(result).toBe(answer);
  });
});

describe('PUT /identities/:identityId/staff-preferences/me', () => {
  it("forwards the caller, the identity id and the body's preference", async () => {
    const attributionSettings = makeAttributionSettings();
    const answer = {
      shouldShowStaffNames: true,
      shouldAllowMyName: false,
      isOwner: false,
    };
    attributionSettings.updateOwnStaffPreference.mockResolvedValue(answer);
    const controller = new IdentitiesController(
      {} as never,
      attributionSettings as never,
    );

    const result = await controller.updateOwnStaffPreference(
      { userId: 'staff-user' } as never,
      'cafe-identity',
      { shouldAllowNaming: false },
    );

    expect(attributionSettings.updateOwnStaffPreference).toHaveBeenCalledWith(
      'staff-user',
      'cafe-identity',
      false,
    );
    expect(result).toBe(answer);
  });
});
