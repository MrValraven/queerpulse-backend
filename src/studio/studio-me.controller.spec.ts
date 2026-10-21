import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { StudioAccessService } from './studio-access.service';
import { StudioMeController } from './studio-me.controller';
import { StudioOwnershipService } from './studio-ownership.service';

const MEMBER = {
  userId: 'c9000000-0000-4000-8000-000000000001',
} as CurrentUserData;

describe('StudioMeController', () => {
  let access: { hasAccess: jest.Mock };
  let ownership: {
    listUploadablePersonas: jest.Mock;
    countOpenCounterWindows: jest.Mock;
  };
  let controller: StudioMeController;

  beforeEach(() => {
    access = { hasAccess: jest.fn().mockResolvedValue(true) };
    ownership = {
      listUploadablePersonas: jest.fn().mockResolvedValue([]),
      countOpenCounterWindows: jest.fn().mockResolvedValue(3),
    };
    controller = new StudioMeController(
      access as unknown as StudioAccessService,
      ownership as unknown as StudioOwnershipService,
    );
  });

  it('reports the open counter-notice windows to a member with a grant', async () => {
    await expect(controller.me(MEMBER)).resolves.toEqual({
      hasAccess: true,
      uploadablePersonas: [],
      counterWindowsOpen: 3,
    });
    expect(ownership.countOpenCounterWindows).toHaveBeenCalledWith(
      MEMBER.userId,
    );
  });

  it('answers 0 without a grant and reads nothing more', async () => {
    access.hasAccess.mockResolvedValue(false);
    await expect(controller.me(MEMBER)).resolves.toEqual({
      hasAccess: false,
      uploadablePersonas: [],
      counterWindowsOpen: 0,
    });
    expect(ownership.countOpenCounterWindows).not.toHaveBeenCalled();
    expect(ownership.listUploadablePersonas).not.toHaveBeenCalled();
  });
});
