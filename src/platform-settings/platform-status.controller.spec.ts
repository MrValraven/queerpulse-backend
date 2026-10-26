import { ConfigService } from '@nestjs/config';
import { AnnouncementDismissalService } from './announcement-dismissal.service';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformStatusController } from './platform-status.controller';

function build(emailEnabled: boolean | undefined) {
  const settings = {
    get: jest.fn().mockResolvedValue({
      registrationEnabled: true,
      joinRequestsEnabled: true,
      lockdownEnabled: false,
      lockdownMessage: null,
      registrationClosedMessage: null,
      announcementEnabled: false,
      announcementExpiresAt: null,
      announcementMessage: null,
      announcementVersion: null,
    }),
  };
  const dismissals = { isDismissed: jest.fn().mockResolvedValue(false) };
  const config = {
    get: jest.fn((key: string) =>
      key === 'email.enabled' ? emailEnabled : undefined,
    ),
  };
  return new PlatformStatusController(
    settings as unknown as PlatformSettingsService,
    dismissals as unknown as AnnouncementDismissalService,
    config as unknown as ConfigService,
  );
}

describe('PlatformStatusController', () => {
  it('reports emailCodeSignIn true when the email-code sign-in is on', async () => {
    const status = await build(true).get(undefined);
    expect(status.emailCodeSignIn).toBe(true);
  });

  it.each([false, undefined])(
    'reports emailCodeSignIn false when email.enabled is %s',
    async (emailEnabled) => {
      const status = await build(emailEnabled).get(undefined);
      expect(status.emailCodeSignIn).toBe(false);
    },
  );

  it('keeps the existing flags beside emailCodeSignIn', async () => {
    const status = await build(true).get(undefined);
    expect(status).toMatchObject({
      registrationOpen: true,
      joinRequestsOpen: true,
      locked: false,
      announcementEnabled: false,
      announcementDismissed: false,
    });
  });
});
