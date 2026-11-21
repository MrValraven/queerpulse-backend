import { RosterRole } from './entities/community-member.entity';
import {
  MARK_SETUP_CHECKLIST_DISMISSED_SQL,
  isSetupChecklistViewer,
  setupChecklistUnavailableForSpacesError,
  toCommunitySetupChecklist,
} from './community-setup-checklist';

describe('community setup checklist', () => {
  it.each([RosterRole.Owner, RosterRole.CoOwner, RosterRole.Mod])(
    'shows the checklist to a %s of a top-level community',
    (role) => {
      expect(isSetupChecklistViewer(role, { parentId: null })).toBe(true);
    },
  );

  it.each([RosterRole.Member, null])(
    'hides the checklist from role %s',
    (role) => {
      expect(isSetupChecklistViewer(role, { parentId: null })).toBe(false);
    },
  );

  it('hides the checklist on a space from its own staff', () => {
    expect(
      isSetupChecklistViewer(RosterRole.Owner, { parentId: 'parent-1' }),
    ).toBe(false);
    expect(
      isSetupChecklistViewer(RosterRole.Mod, { parentId: 'parent-1' }),
    ).toBe(false);
  });

  it('reads a stamped dismissal as dismissed and carries both counts', () => {
    expect(
      toCommunitySetupChecklist(
        { setupChecklistDismissedAt: new Date('2026-11-20T10:00:00.000Z') },
        { staffCount: 2, postCount: 7 },
      ),
    ).toEqual({ isDismissed: true, staffCount: 2, postCount: 7 });
    expect(
      toCommunitySetupChecklist(
        { setupChecklistDismissedAt: null },
        { staffCount: 1, postCount: 0 },
      ),
    ).toEqual({ isDismissed: false, staffCount: 1, postCount: 0 });
  });

  it('answers the space refusal with 400 and the contract code', () => {
    const error = setupChecklistUnavailableForSpacesError();
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      message: 'Spaces have no setup checklist to dismiss.',
      code: 'setup_checklist_unavailable_for_spaces',
    });
  });

  it('stamps only a checklist that is still open', () => {
    expect(MARK_SETUP_CHECKLIST_DISMISSED_SQL.replace(/\s+/g, ' ').trim()).toBe(
      'UPDATE "communities" SET "setup_checklist_dismissed_at" = now() WHERE "id" = $1 AND "setup_checklist_dismissed_at" IS NULL',
    );
  });
});
