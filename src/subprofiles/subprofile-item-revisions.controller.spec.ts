import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { SubprofileItemRevisionsController } from './subprofile-item-revisions.controller';

/**
 * ENG-448: `restoreRevision` writes a portfolio item's live content (other
 * co-owners and, once published, the public read it), so it needs
 * `NotRestrictedGuard` the same as every other content-write route on a
 * persona. `listRevisions`/`getRevision` are reads and stay open.
 */
describe('SubprofileItemRevisionsController write-gate guard (ENG-448)', () => {
  it('guards restoreRevision with NotRestrictedGuard', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = SubprofileItemRevisionsController.prototype.restoreRevision;
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as
      unknown[] | undefined;
    expect(guards).toContain(NotRestrictedGuard);
  });

  it.each(['listRevisions', 'getRevision'] as const)(
    'leaves the read-only %s open',
    (name) => {
      const prototype =
        SubprofileItemRevisionsController.prototype as unknown as Record<
          'listRevisions' | 'getRevision',
          () => unknown
        >;

      const handler = prototype[name];
      const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as
        unknown[] | undefined;
      expect(guards ?? []).not.toContain(NotRestrictedGuard);
    },
  );
});

/**
 * ENG-451: a restore is a persona content write, so it carries the editor's
 * `expectedEditVersion` to the service (checked under the persona row lock)
 * and answers the raised `editVersion` beside `ok`.
 */
describe('SubprofileItemRevisionsController.restoreRevision edit version (ENG-451)', () => {
  const editorUser: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.c',
    status: 'active',
    role: 'member',
  };

  function buildController() {
    const subprofilesService = {
      restoreRevision: jest.fn().mockResolvedValue(8),
    };
    const controller = new SubprofileItemRevisionsController(
      subprofilesService as never,
    );
    return { controller, subprofilesService };
  }

  it('passes expectedEditVersion and answers the raised editVersion', async () => {
    const { controller, subprofilesService } = buildController();

    const response = await controller.restoreRevision(
      editorUser,
      'sp1',
      'it1',
      'rev1',
      { expectedEditVersion: 7 },
    );

    expect(subprofilesService.restoreRevision).toHaveBeenCalledWith(
      'u1',
      'sp1',
      'it1',
      'rev1',
      7,
    );
    expect(response).toEqual({ ok: true, editVersion: 8 });
  });

  it.each([
    ['an empty body', {}],
    ['an absent body', undefined],
  ])('restores with no precondition for %s', async (_label, body) => {
    const { controller, subprofilesService } = buildController();

    const response = await controller.restoreRevision(
      editorUser,
      'sp1',
      'it1',
      'rev1',
      body,
    );

    expect(subprofilesService.restoreRevision).toHaveBeenCalledWith(
      'u1',
      'sp1',
      'it1',
      'rev1',
      undefined,
    );
    expect(response).toEqual({ ok: true, editVersion: 8 });
  });
});
