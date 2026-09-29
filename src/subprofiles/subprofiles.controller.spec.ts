import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  ACCOUNT_RESTRICTED_CODE,
  NotRestrictedGuard,
} from '../auth/guards/not-restricted.guard';
import type { UpdateSubprofileDTO } from './dto/update-subprofile.dto';
import { SubprofileVisibility } from './entities/subprofile.entity';
import { SubprofilesController } from './subprofiles.controller';

type GuardedHandlerName =
  | 'replaceSection'
  | 'replaceSocialLinks'
  | 'replaceAffiliations'
  | 'acceptInvite';

type OpenHandlerName =
  | 'unpublish'
  | 'remove'
  | 'leave'
  | 'reorderMine'
  | 'removeMember'
  | 'revokeInvite'
  | 'withdrawEndorsement';

function guardsFor(name: GuardedHandlerName | OpenHandlerName): unknown[] {
  const prototype = SubprofilesController.prototype as unknown as Record<
    GuardedHandlerName | OpenHandlerName,
    () => unknown
  >;

  const handler = prototype[name];
  return (
    (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ??
    []
  );
}

/**
 * ENG-448: a restricted member keeps every read and every take-down action on
 * their own personas (see `NotRestrictedGuard`'s own docstring: "taking
 * something down is the direction a restriction wants") and stays blocked
 * from writing content that other co-owners and, once published, the public
 * read: a section replace, social links, affiliations, and accepting a
 * co-owner invite (seats the caller on a shared roster and mailbox, and
 * notifies the other co-owners, matching the group-invite-accept precedent,
 * M1 fix round 1). `NotRestrictedGuard` has to sit at the METHOD level on
 * each of these: the class level would also catch `GET :id`, `unpublish` and
 * `leave`, which must stay open to a restricted member. What each handler
 * actually does is exercised by `SubprofilesService`'s own spec; this only
 * proves the gate is wired to the route.
 *
 * `update` (`PATCH :id`) is NOT guard-metadata based any more (M3 fix
 * round 1): see the `SubprofilesController.update restriction gate` block
 * below for its inline check. `reorderMine` (`PUT order`) stays
 * deliberately open (M4): see the open-handlers list.
 */
describe('SubprofilesController write-gate guards (ENG-448)', () => {
  const guardedHandlers: GuardedHandlerName[] = [
    'replaceSection',
    'replaceSocialLinks',
    'replaceAffiliations',
    'acceptInvite',
  ];

  it.each(guardedHandlers)('guards %s with NotRestrictedGuard', (name) => {
    expect(guardsFor(name)).toContain(NotRestrictedGuard);
  });

  // M2 (fix round 1): pins the routes left open ON PURPOSE, so a later sweep
  // cannot add the guard to them by accident.
  //   - unpublish/remove/leave: taking the persona down, or leaving it. This
  //     is the "own things" direction the guard contract keeps open.
  //   - reorderMine: own account settings (M4). See its own comment in the
  //     controller.
  //   - removeMember: creator-only eviction of a co-owner FROM the creator's
  //     own persona. A roster removal with no member-authored text;
  //     blocking it would also trap a restricted creator with a co-owner who
  //     can still edit (reviewer-agreed, task-2-review.md).
  //   - revokeInvite: withdrawing an invite the caller (or a co-owner) sent.
  //     Same direction as `unpublish`/`remove`.
  //   - withdrawEndorsement: withdrawing the caller's own endorsement of
  //     ANOTHER persona. A withdrawal of the caller's own standing, distinct
  //     from any write to this persona's content.
  const openHandlers: OpenHandlerName[] = [
    'unpublish',
    'remove',
    'leave',
    'reorderMine',
    'removeMember',
    'revokeInvite',
    'withdrawEndorsement',
  ];

  it.each(openHandlers)(
    'leaves %s open to a restricted member (its own take-down or withdrawal)',
    (name) => {
      expect(guardsFor(name)).not.toContain(NotRestrictedGuard);
    },
  );
});

/**
 * M3 (fix round 1, revised fix round 2): `PATCH :id` carries every core
 * field a persona has, including `visibility`. Every field but a narrowing
 * `visibility` reaches other co-owners and, once published, the public, so
 * it keeps the same refusal `NotRestrictedGuard` gives the rest of this
 * controller's content writes, checked inline (ENG-237-style,
 * `messaging.controller.ts`'s conversation PATCH) so a restricted member can
 * still narrow a persona's audience (a take-down-direction privacy change)
 * while every other field stays refused. "Narrowing" can only be known
 * against the persona's CURRENT stored visibility (fix round 1's body-only
 * check let a restricted member widen a `private` persona to `network`,
 * since it only asked "is the target not Open"), so every test below sets up
 * `getOwnedDTO` to return the persona's current visibility and asserts
 * against the real `open > network > private` order.
 */
describe('SubprofilesController.update restriction gate (M3, fix round 2)', () => {
  function buildController(
    user: CurrentUserData,
    currentVisibility: SubprofileVisibility = SubprofileVisibility.Open,
  ) {
    const subprofilesService = {
      update: jest.fn().mockResolvedValue({ id: 'sp1' }),
      getOwnedDTO: jest
        .fn()
        .mockResolvedValue({ visibility: currentVisibility }),
    };
    const controller = new SubprofilesController(
      subprofilesService as never,
      {} as never,
    );
    return {
      controller,
      subprofilesService,
      call: (dto: UpdateSubprofileDTO) => controller.update(user, 'sp1', dto),
    };
  }

  function restrictedUser(): CurrentUserData {
    return {
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
      restricted: true,
    };
  }

  /** Awaits a rejection and checks both the exception class and its coded
   *  body, mirroring `subprofile-invites.service.spec.ts`'s own helper. */
  async function expectRestricted(pending: Promise<unknown>): Promise<void> {
    const caught: unknown = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({
      code: ACCOUNT_RESTRICTED_CODE,
    });
  }

  it('lets a restricted member narrow visibility from open to network', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Open,
    );

    await expect(
      call({ visibility: SubprofileVisibility.Network }),
    ).resolves.toEqual({ id: 'sp1' });
    expect(subprofilesService.update).toHaveBeenCalledWith(
      'u1',
      'sp1',
      expect.objectContaining({ visibility: SubprofileVisibility.Network }),
    );
  });

  it('lets a restricted member narrow visibility from open to private', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Open,
    );

    await expect(
      call({ visibility: SubprofileVisibility.Private }),
    ).resolves.toEqual({ id: 'sp1' });
    expect(subprofilesService.update).toHaveBeenCalled();
  });

  it('lets a restricted member narrow visibility from network to private', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Network,
    );

    await expect(
      call({ visibility: SubprofileVisibility.Private }),
    ).resolves.toEqual({ id: 'sp1' });
    expect(subprofilesService.update).toHaveBeenCalled();
  });

  it('refuses a restricted member widening visibility from private to network', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Private,
    );

    await expectRestricted(call({ visibility: SubprofileVisibility.Network }));
    expect(subprofilesService.update).not.toHaveBeenCalled();
  });

  it('refuses a restricted member widening visibility to open', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Network,
    );

    await expectRestricted(call({ visibility: SubprofileVisibility.Open }));
    expect(subprofilesService.update).not.toHaveBeenCalled();
  });

  it('refuses a restricted member on a same-value visibility body (private to private)', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Private,
    );

    await expectRestricted(call({ visibility: SubprofileVisibility.Private }));
    expect(subprofilesService.update).not.toHaveBeenCalled();
  });

  it('refuses a restricted member narrowing visibility alongside any other field', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Network,
    );

    await expectRestricted(
      call({ visibility: SubprofileVisibility.Private, tagline: 'hi' }),
    );
    expect(subprofilesService.update).not.toHaveBeenCalled();
  });

  // Task 4 (ENG-451) added `expectedEditVersion` as a save precondition the
  // editor sends on every PATCH; it names no field, so a body pairing it
  // with a narrowing `visibility` still counts as visibility-only.
  it('lets a restricted member narrow visibility alongside expectedEditVersion', async () => {
    const { call, subprofilesService } = buildController(
      restrictedUser(),
      SubprofileVisibility.Network,
    );

    await expect(
      call({
        visibility: SubprofileVisibility.Private,
        expectedEditVersion: 3,
      }),
    ).resolves.toEqual({ id: 'sp1' });
    expect(subprofilesService.update).toHaveBeenCalledWith(
      'u1',
      'sp1',
      expect.objectContaining({
        visibility: SubprofileVisibility.Private,
        expectedEditVersion: 3,
      }),
    );
  });

  it('refuses a restricted member editing any non-visibility field', async () => {
    const { call, subprofilesService } = buildController(restrictedUser());

    await expectRestricted(call({ tagline: 'hi' }));
    expect(subprofilesService.update).not.toHaveBeenCalled();
    // A body that isn't visibility-only never triggers the current-row read.
    expect(subprofilesService.getOwnedDTO).not.toHaveBeenCalled();
  });

  it('lets a member who is not restricted edit any field', async () => {
    const notRestricted: CurrentUserData = {
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    };
    const { call, subprofilesService } = buildController(notRestricted);

    await expect(
      call({ tagline: 'hi', avatarUrl: 'avatars/x.jpg' }),
    ).resolves.toEqual({ id: 'sp1' });
    expect(subprofilesService.update).toHaveBeenCalled();
    expect(subprofilesService.getOwnedDTO).not.toHaveBeenCalled();
  });
});

/**
 * ENG-451: each replace-all PUT hands the body's `expectedEditVersion` to the
 * service, which checks it under the persona row lock. A handler that
 * dropped it would make every PUT unconditional with no error anywhere.
 */
describe('SubprofilesController replace-all PUTs pass expectedEditVersion (ENG-451)', () => {
  const editorUser: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.c',
    status: 'active',
    role: 'member',
  };

  function buildController() {
    const subprofilesService = {
      replaceSection: jest.fn().mockResolvedValue({ id: 'sp1' }),
      replaceSocialLinks: jest.fn().mockResolvedValue({ id: 'sp1' }),
      replaceAffiliations: jest.fn().mockResolvedValue({ id: 'sp1' }),
    };
    const controller = new SubprofilesController(
      subprofilesService as never,
      {} as never,
    );
    return { controller, subprofilesService };
  }

  it('passes it to replaceSection', async () => {
    const { controller, subprofilesService } = buildController();

    await controller.replaceSection(editorUser, 'sp1', 'projects', {
      items: [],
      expectedEditVersion: 7,
    });

    expect(subprofilesService.replaceSection).toHaveBeenCalledWith(
      'u1',
      'sp1',
      'projects',
      [],
      7,
    );
  });

  it('passes it to replaceSocialLinks', async () => {
    const { controller, subprofilesService } = buildController();

    await controller.replaceSocialLinks(editorUser, 'sp1', {
      items: [],
      expectedEditVersion: 7,
    });

    expect(subprofilesService.replaceSocialLinks).toHaveBeenCalledWith(
      'u1',
      'sp1',
      [],
      7,
    );
  });

  it('passes it to replaceAffiliations', async () => {
    const { controller, subprofilesService } = buildController();

    await controller.replaceAffiliations(editorUser, 'sp1', {
      items: [],
      expectedEditVersion: 7,
    });

    expect(subprofilesService.replaceAffiliations).toHaveBeenCalledWith(
      'u1',
      'sp1',
      [],
      7,
    );
  });

  it('passes undefined when the body carries none', async () => {
    const { controller, subprofilesService } = buildController();

    await controller.replaceSocialLinks(editorUser, 'sp1', { items: [] });

    expect(subprofilesService.replaceSocialLinks).toHaveBeenCalledWith(
      'u1',
      'sp1',
      [],
      undefined,
    );
  });
});
