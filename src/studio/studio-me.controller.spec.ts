import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { StudioAccessRequestsService } from './studio-access-requests.service';
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
  let accessRequests: { findOwnRequest: jest.Mock };
  let controller: StudioMeController;

  beforeEach(() => {
    access = { hasAccess: jest.fn().mockResolvedValue(true) };
    ownership = {
      listUploadablePersonas: jest.fn().mockResolvedValue([]),
      countOpenCounterWindows: jest.fn().mockResolvedValue(3),
    };
    accessRequests = { findOwnRequest: jest.fn().mockResolvedValue(null) };
    controller = new StudioMeController(
      access as unknown as StudioAccessService,
      ownership as unknown as StudioOwnershipService,
      accessRequests as unknown as StudioAccessRequestsService,
    );
  });

  it('reports the open counter-notice windows to a member with a grant', async () => {
    await expect(controller.me(MEMBER)).resolves.toEqual({
      hasAccess: true,
      uploadablePersonas: [],
      counterWindowsOpen: 3,
      hasPendingRequest: false,
      wantsToRelease: false,
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
      hasPendingRequest: false,
      wantsToRelease: false,
    });
    expect(ownership.countOpenCounterWindows).not.toHaveBeenCalled();
    expect(ownership.listUploadablePersonas).not.toHaveBeenCalled();
  });

  it('answers the waiting request for a member without access', async () => {
    access.hasAccess.mockResolvedValue(false);
    accessRequests.findOwnRequest.mockResolvedValue({
      wantsToRelease: true,
      requestedAt: '2026-10-28T09:00:00.000Z',
    });
    await expect(controller.me(MEMBER)).resolves.toEqual({
      hasAccess: false,
      uploadablePersonas: [],
      counterWindowsOpen: 0,
      hasPendingRequest: true,
      wantsToRelease: true,
    });
    expect(accessRequests.findOwnRequest).toHaveBeenCalledWith(MEMBER.userId);
  });

  it('answers no request for a member with access', async () => {
    accessRequests.findOwnRequest.mockResolvedValue({
      wantsToRelease: true,
      requestedAt: '2026-10-28T09:00:00.000Z',
    });
    const response = await controller.me(MEMBER);
    expect([response.hasPendingRequest, response.wantsToRelease]).toEqual([
      false,
      false,
    ]);
    expect(accessRequests.findOwnRequest).not.toHaveBeenCalled();
  });
});
