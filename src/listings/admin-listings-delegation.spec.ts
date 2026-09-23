import { Reflector } from '@nestjs/core';
import { AdminListingsController } from './admin-listings.controller';
import { UserRole } from '../users/entities/user.entity';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';

/**
 * WHO CAN REASSIGN A BUSINESS.
 *
 * `AdminListingsController` carries `@StaffRoles('directory_moderator')` at
 * class level, which is what lets a plain member holding that grant work the
 * listings moderation queue. The delegation routes are a different kind of
 * act: they decide who owns a public page about a queer venue and who sits
 * behind it. Those are platform-tier decisions.
 *
 * `RolesOrStaffGuard` resolves both metadata keys with `getAllAndOverride`, so
 * narrowing a handler to `@Roles(UserRole.Admin)` on its own does nothing:
 * the class-level grant stays in scope and the route remains open to every
 * grant holder. The empty `@StaffRoles()` on the handler is what switches the
 * grant axis off and leaves `@Roles` as the whole gate.
 *
 * The failure is silent. Nothing throws, no route 500s, and the only symptom
 * is a volunteer being able to hand a business to somebody. That is why the
 * decorator pair is asserted here, per route, by a test.
 */
describe('AdminListingsController delegation route guards', () => {
  const reflector = new Reflector();

  /** The route handler itself, read off the prototype by name. Reached
   * through a computed key, and typed as a bare callable, so the reference is
   * never a method bound to a `this`. */
  const handlerOf = (
    methodName: keyof AdminListingsController,
  ): ((...args: never[]) => unknown) =>
    AdminListingsController.prototype[methodName];

  const delegationRoutes = [
    'create',
    'getOwnershipOffer',
    'offerOwnership',
    'revokeOwnershipOffer',
    'listCoManagers',
    'inviteCoManager',
    'revokeCoManager',
  ] as const;

  it.each(delegationRoutes)(
    '%s is narrowed to admin with an empty staff-role override',
    (methodName) => {
      const handler = handlerOf(methodName);

      const roles = reflector.get<UserRole[]>(ROLES_KEY, handler);
      const staffRoles = reflector.get<string[]>(STAFF_ROLES_KEY, handler);

      expect(roles).toEqual([UserRole.Admin]);
      // The empty array is what overrides the class-level
      // directory_moderator grant. Without it RolesOrStaffGuard would keep
      // the class metadata in scope and re-open the route.
      expect(staffRoles).toEqual([]);
    },
  );

  it('the moderation queue route keeps the wider class-level access', () => {
    const handler = handlerOf('listQueue');
    expect(reflector.get(STAFF_ROLES_KEY, handler)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, handler)).toBeUndefined();
  });

  it('the class still grants the directory_moderator role the routes it was given', () => {
    expect(
      reflector.get<string[]>(STAFF_ROLES_KEY, AdminListingsController),
    ).toEqual(['directory_moderator']);
    expect(
      reflector.get<UserRole[]>(ROLES_KEY, AdminListingsController),
    ).toEqual([UserRole.Moderator, UserRole.Admin]);
  });

  /**
   * ROUTE ORDER.
   *
   * `removeByModerator` sits on the bare `@Delete(':ref')`, and this class's
   * doc comment states the rule the whole file follows: a route carrying a
   * literal segment is declared before the parameter route that could absorb
   * it. Nest matches handlers in declaration order, so the rule is what keeps
   * a path segment from being bound as a `ref` value as these paths grow.
   * Pinned here because the cost of getting it wrong is a delegation call
   * silently deleting a listing, and declaration order is invisible in
   * review once the class is 500 lines long. Property order on the prototype
   * is the order the decorators registered the handlers.
   */
  it('declares every delegation route above the bare :ref delete', () => {
    const declarationOrder = Object.getOwnPropertyNames(
      AdminListingsController.prototype,
    );
    const bareDeleteIndex = declarationOrder.indexOf('removeByModerator');
    expect(bareDeleteIndex).toBeGreaterThan(-1);

    for (const methodName of delegationRoutes) {
      expect(declarationOrder.indexOf(methodName)).toBeLessThan(
        bareDeleteIndex,
      );
    }
  });
});
