import { ForbiddenException } from '@nestjs/common';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

function makeService(
  staff: string[],
  identity: Partial<Identity> = {
    id: 'identity-1',
    kind: IdentityKind.Listing,
    listingId: 'listing-1',
  },
  subprofileRows: Array<{ id: string; removedAt: Date | null }> = [],
) {
  const service = Object.create(
    IdentitiesService.prototype,
  ) as IdentitiesService;
  jest.spyOn(service, 'staffUserIds').mockResolvedValue(staff);
  jest.spyOn(service, 'getById').mockResolvedValue(identity as Identity);
  // Task 15 fix round 1: the removed-persona read.
  Object.assign(service, {
    subprofiles: { find: jest.fn().mockResolvedValue(subprofileRows) },
  });
  return service;
}

const PERSONA_IDENTITY: Partial<Identity> = {
  id: 'persona-identity',
  kind: IdentityKind.Subprofile,
  subprofileId: 'persona-1',
};

describe('IdentitiesService.assertMayActAs', () => {
  it('resolves for a staff member', async () => {
    const service = makeService(['owner-user', 'comanager-user']);
    await expect(
      service.assertMayActAs('comanager-user', 'identity-1'),
    ).resolves.toBeUndefined();
  });

  it('throws a coded ForbiddenException for a stranger', async () => {
    const service = makeService(['owner-user']);
    // expect.assertions guards both checks. Written as a catch block whose
    // assertions could be skipped, a gate that stopped rejecting would leave
    // the code check silently unexecuted and the test still green.
    expect.assertions(2);
    try {
      await service.assertMayActAs('stranger', 'identity-1');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual({
        code: 'IDENTITY_NOT_STAFF',
        message: 'You cannot send as this identity',
      });
    }
  });

  it('throws for an identity with no staff at all', async () => {
    const service = makeService([]);
    await expect(service.assertMayActAs('anyone', 'ownerless')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses a staff member of a persona that moderation removed, with its own code', async () => {
    const service = makeService(['owner-user'], PERSONA_IDENTITY, [
      { id: 'persona-1', removedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    expect.assertions(2);
    try {
      await service.assertMayActAs('owner-user', 'persona-identity');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({ code: 'IDENTITY_REMOVED' }),
      );
    }
  });

  it('lets a staff member of a persona in good standing act as it', async () => {
    const service = makeService(['owner-user'], PERSONA_IDENTITY, [
      { id: 'persona-1', removedAt: null },
    ]);
    await expect(
      service.assertMayActAs('owner-user', 'persona-identity'),
    ).resolves.toBeUndefined();
  });

  it('keeps read access to a removed persona: the staff list is unchanged', async () => {
    const service = makeService(['owner-user'], PERSONA_IDENTITY, [
      { id: 'persona-1', removedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    await expect(
      service.isAllowedToActAs('owner-user', 'persona-identity'),
    ).resolves.toBe(true);
  });

  it('answers a stranger to a removed persona as not staff', async () => {
    const service = makeService(['owner-user'], PERSONA_IDENTITY, [
      { id: 'persona-1', removedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    const error: unknown = await service
      .assertMayActAs('stranger', 'persona-identity')
      .catch((rejection: unknown) => rejection);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'IDENTITY_NOT_STAFF',
    });
  });

  // CW-28: a moderation-removed persona may still DELETE its own past
  // messages; every other write stays refused with IDENTITY_REMOVED.
  describe('the isDeletingOwnMessage exception (CW-28)', () => {
    it("lets a removed persona's own staff act as it when deleting its own message", async () => {
      const service = makeService(['owner-user'], PERSONA_IDENTITY, [
        { id: 'persona-1', removedAt: new Date('2026-09-01T00:00:00Z') },
      ]);
      await expect(
        service.assertMayActAs('owner-user', 'persona-identity', {
          isDeletingOwnMessage: true,
        }),
      ).resolves.toBeUndefined();
    });

    it('still refuses a stranger even when isDeletingOwnMessage is set', async () => {
      const service = makeService(['owner-user'], PERSONA_IDENTITY, [
        { id: 'persona-1', removedAt: new Date('2026-09-01T00:00:00Z') },
      ]);
      const error: unknown = await service
        .assertMayActAs('stranger', 'persona-identity', {
          isDeletingOwnMessage: true,
        })
        .catch((rejection: unknown) => rejection);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'IDENTITY_NOT_STAFF',
      });
    });

    it('keeps refusing every write that is not the delete exception, with IDENTITY_REMOVED', async () => {
      const service = makeService(['owner-user'], PERSONA_IDENTITY, [
        { id: 'persona-1', removedAt: new Date('2026-09-01T00:00:00Z') },
      ]);
      expect.assertions(2);
      try {
        await service.assertMayActAs('owner-user', 'persona-identity', {
          isDeletingOwnMessage: false,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toEqual(
          expect.objectContaining({ code: 'IDENTITY_REMOVED' }),
        );
      }
    });
  });
});
