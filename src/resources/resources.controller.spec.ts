import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ResourcesController } from './resources.controller';

/**
 * Route metadata only (same shape as `public-profiles.controller.spec.ts`).
 *
 * The three guide reads carry `@Public()` for a reason that is easy to undo by
 * accident: the guide PAGES are reachable by a logged-out visitor, so the
 * frontend has to be able to ask the backend whether a guide has passed
 * editorial review. If these reads go back to members-only, an anonymous
 * caller is rejected before the handler runs, `useManagedGuide` reads that as
 * "could not ask" and falls open to the hardcoded page, and the review gate
 * silently stops applying to anybody who is not signed in. Nothing else in the
 * suite would notice, so it is asserted here.
 */
describe('ResourcesController route metadata', () => {
  const reflector = new Reflector();

  // Read as metadata targets only — never invoked, so the unbound `this` the
  // rule warns about cannot arise.
  /* eslint-disable @typescript-eslint/unbound-method */
  const publicReads = {
    listIndex: ResourcesController.prototype.listIndex,
    list: ResourcesController.prototype.list,
    getBySlug: ResourcesController.prototype.getBySlug,
  };
  const memberOnlyWrites = {
    createSuggestion: ResourcesController.prototype.createSuggestion,
    listListings: ResourcesController.prototype.listListings,
  };
  /* eslint-enable @typescript-eslint/unbound-method */

  it.each(Object.entries(publicReads))(
    'serves %s to a logged-out visitor',
    (_name, handler) => {
      expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    },
  );

  // The gate opened exactly three reads. Anything that writes, or that serves
  // a member-only directory, stays behind `ActiveMemberGuard`.
  it.each(Object.entries(memberOnlyWrites))(
    'leaves %s behind the active-member guard',
    (_name, handler) => {
      expect(reflector.get(IS_PUBLIC_KEY, handler)).toBeUndefined();
    },
  );
});
