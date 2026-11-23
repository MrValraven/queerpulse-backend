import { PushController } from './push.controller';
import { PushService } from './push.service';
import type { PushPreviewPrivacyService } from './push-preview-privacy.service';

function makeService() {
  return {
    saveSubscription: jest.fn().mockResolvedValue(undefined),
    removeSubscription: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PushController', () => {
  it("sends a test push to the caller in the caller's language and returns ok", async () => {
    const service = makeService();
    const previewPrivacy = {
      sendGenericByLanguage: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new PushController(
      service as unknown as PushService,
      previewPrivacy as unknown as PushPreviewPrivacyService,
    );

    const result = await controller.test({ userId: 'user-1' } as never);

    expect(previewPrivacy.sendGenericByLanguage).toHaveBeenCalledTimes(1);
    expect(previewPrivacy.sendGenericByLanguage).toHaveBeenCalledWith(
      ['user-1'],
      expect.objectContaining({
        title: 'Test notification',
        body: 'This is a test. Your notifications are working.',
        tag: 'push-test',
        data: { url: '/account/settings' },
        l10n: { titleKey: 'push:test.title', bodyKey: 'push:test.body' },
      }),
      expect.objectContaining({
        pt: {
          title: 'Notificação de teste',
          body: 'Isto é um teste. As tuas notificações estão a funcionar.',
        },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('links a new subscription to the caller’s session family (SEC-12)', async () => {
    const service = makeService();
    const controller = new PushController(
      service as unknown as PushService,
      {} as unknown as PushPreviewPrivacyService,
    );
    const dto = {
      endpoint: 'https://push.example.test/e1',
      keys: { p256dh: 'k1', auth: 'a1' },
    };

    await controller.subscribe(
      { userId: 'user-1', sessionId: 'family-1' } as never,
      dto,
      'agent',
    );

    expect(service.saveSubscription).toHaveBeenCalledWith(
      'user-1',
      dto,
      'agent',
      'family-1',
    );
  });
});
