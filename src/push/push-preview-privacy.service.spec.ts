import { In, type Repository } from 'typeorm';
import type { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { GENERIC_PUSH_COPY } from './generic-push-copy';
import { PushPreviewPrivacyService } from './push-preview-privacy.service';
import type { PushPayload, PushService } from './push.service';

const SENDER_NAME = 'Mariana';
const MESSAGE_TEXT = 'are you still coming on Thursday?';
const AVATAR_URL = 'https://images.example/avatars/mariana.jpg';
const PREVIEW_IMAGE_URL = 'https://images.example/previews/photo.jpg';

/** A DM push carrying every identifying field a payload can hold. */
function makeRichPayload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    title: SENDER_NAME,
    body: MESSAGE_TEXT,
    tag: 'conversation-1',
    data: { url: '/messages/conversation-1', conversationId: 'conversation-1' },
    icon: AVATAR_URL,
    image: PREVIEW_IMAGE_URL,
    actions: [{ action: 'reply', title: `Reply to ${SENDER_NAME}` }],
    vibrate: [100, 50, 100],
    requireInteraction: true,
    silent: false,
    renotify: true,
    timestamp: 1789462800000,
    l10n: {
      titleKey: 'push:message.title',
      bodyKey: 'push:message.body',
      params: { name: SENDER_NAME, body: MESSAGE_TEXT },
    },
    ...overrides,
  };
}

/** Resolves once every pending microtask and I/O callback has run. */
function flushPendingWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('PushPreviewPrivacyService.sendSplitByPreviewPreference (ID-13)', () => {
  let service: PushPreviewPrivacyService;
  let preferences: { find: jest.Mock };
  let pushService: { sendToUsers: jest.Mock };

  /** The payload handed to the generic (hidden-preview) send. */
  function lockedPayload(): PushPayload {
    const call = pushService.sendToUsers.mock.calls[1] as
      [string[], PushPayload] | undefined;
    if (!call) {
      throw new Error('the generic send never ran');
    }
    return call[1];
  }

  beforeEach(() => {
    preferences = { find: jest.fn().mockResolvedValue([]) };
    pushService = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    service = new PushPreviewPrivacyService(
      preferences as unknown as Repository<MemberPreferences>,
      pushService as unknown as PushService,
    );
  });

  it('sends nothing and reads no preferences for an empty batch', async () => {
    await service.sendSplitByPreviewPreference([], makeRichPayload());

    expect(preferences.find).not.toHaveBeenCalled();
    expect(pushService.sendToUsers).not.toHaveBeenCalled();
  });

  it("reads the whole batch's preference in one query", async () => {
    await service.sendSplitByPreviewPreference(
      ['first', 'second', 'third'],
      makeRichPayload(),
    );

    expect(preferences.find).toHaveBeenCalledTimes(1);
    expect(preferences.find).toHaveBeenCalledWith({
      where: { userId: In(['first', 'second', 'third']) },
      select: { userId: true, hidePushPreviews: true, language: true },
    });
  });

  it('puts the rich payload only in front of members who explicitly turned previews on', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'showing', hidePushPreviews: false },
      { userId: 'hiding', hidePushPreviews: true },
    ]);
    const richPayload = makeRichPayload();

    await service.sendSplitByPreviewPreference(
      ['showing', 'hiding', 'without-row'],
      richPayload,
    );

    expect(pushService.sendToUsers).toHaveBeenCalledTimes(2);
    const [richSend, genericSend] = pushService.sendToUsers.mock.calls as [
      string[],
      PushPayload,
    ][];
    expect(richSend).toEqual([['showing'], richPayload]);
    // FAIL CLOSED: no preferences row reads as hidden.
    expect(genericSend?.[0]).toEqual(['hiding', 'without-row']);
  });

  it('sends the rich payload to nobody when nobody has opted in', async () => {
    await service.sendSplitByPreviewPreference(
      ['without-row'],
      makeRichPayload(),
    );

    const [richSend, genericSend] = pushService.sendToUsers.mock.calls as [
      string[],
      PushPayload,
    ][];
    expect(richSend?.[0]).toEqual([]);
    expect(genericSend?.[0]).toEqual(['without-row']);
  });

  it('strips the locked payload down to the allowlist plus the generic copy', async () => {
    const richPayload = makeRichPayload();

    await service.sendSplitByPreviewPreference(['hiding'], richPayload);

    expect(lockedPayload()).toStrictEqual({
      title: GENERIC_PUSH_COPY.notification.title,
      body: GENERIC_PUSH_COPY.notification.body,
      tag: richPayload.tag,
      data: richPayload.data,
      timestamp: richPayload.timestamp,
      renotify: true,
      l10n: {
        titleKey: GENERIC_PUSH_COPY.notification.titleKey,
        bodyKey: GENERIC_PUSH_COPY.notification.bodyKey,
      },
    });
  });

  it('never lets the sender name, the message text, or an image travel in the locked payload', async () => {
    await service.sendSplitByPreviewPreference(['hiding'], makeRichPayload());

    const payload = lockedPayload();
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(SENDER_NAME);
    expect(serialised).not.toContain('Thursday');
    expect(serialised).not.toContain(AVATAR_URL);
    expect(serialised).not.toContain(PREVIEW_IMAGE_URL);
    expect(payload).not.toHaveProperty('icon');
    expect(payload).not.toHaveProperty('image');
    expect(payload).not.toHaveProperty('actions');
    expect(payload.l10n).not.toHaveProperty('params');
  });

  it('uses the per-category copy the caller passes', async () => {
    await service.sendSplitByPreviewPreference(
      ['hiding'],
      makeRichPayload(),
      GENERIC_PUSH_COPY.message,
    );

    const payload = lockedPayload();
    expect(payload.body).toBe('You have a new message.');
    expect(payload.l10n).toEqual({
      titleKey: GENERIC_PUSH_COPY.message.titleKey,
      bodyKey: GENERIC_PUSH_COPY.message.bodyKey,
    });
  });

  it('sends the Portuguese generic copy to a hiding member whose language is pt (PRD-325)', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'showing-pt', hidePushPreviews: false, language: 'pt' },
      { userId: 'hiding-pt', hidePushPreviews: true, language: 'pt' },
      { userId: 'hiding-en', hidePushPreviews: true, language: 'en' },
    ]);
    const richPayload = makeRichPayload();

    await service.sendSplitByPreviewPreference(
      ['showing-pt', 'hiding-pt', 'hiding-en', 'without-row'],
      richPayload,
      GENERIC_PUSH_COPY.message,
    );

    expect(pushService.sendToUsers).toHaveBeenCalledTimes(3);
    const [richSend, englishSend, portugueseSend] = pushService.sendToUsers.mock
      .calls as [string[], PushPayload][];
    // This DM payload's keys have no catalog entry, so its Portuguese render
    // is the English one and the showing member shares the single rich send.
    expect(richSend).toEqual([['showing-pt'], richPayload]);
    expect(englishSend?.[0]).toEqual(['hiding-en', 'without-row']);
    expect(englishSend?.[1].body).toBe('You have a new message.');
    expect(portugueseSend?.[0]).toEqual(['hiding-pt']);
    expect(portugueseSend?.[1]).toMatchObject({
      title: 'QueerPulse',
      body: 'Tens uma mensagem nova.',
      l10n: {
        titleKey: GENERIC_PUSH_COPY.message.titleKey,
        bodyKey: GENERIC_PUSH_COPY.message.bodyKey,
      },
    });
  });

  it('sends the Portuguese rich copy to a showing member whose language is pt, keeping the l10n keys (PRD-325)', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'showing-pt', hidePushPreviews: false, language: 'pt' },
      { userId: 'showing-en', hidePushPreviews: false, language: 'en' },
      { userId: 'showing-no-language', hidePushPreviews: false },
    ]);
    const richPayload = makeRichPayload({
      title: 'Connection accepted',
      body: `${SENDER_NAME} accepted your connection request.`,
      actions: undefined,
      l10n: {
        titleKey: 'push:connection.accepted.title',
        bodyKey: 'push:connection.accepted.body',
        params: { name: SENDER_NAME },
      },
    });

    await service.sendSplitByPreviewPreference(
      ['showing-pt', 'showing-en', 'showing-no-language'],
      richPayload,
    );

    expect(pushService.sendToUsers).toHaveBeenCalledTimes(3);
    const [englishRichSend, genericSend, portugueseRichSend] = pushService
      .sendToUsers.mock.calls as [string[], PushPayload][];
    expect(englishRichSend).toEqual([
      ['showing-en', 'showing-no-language'],
      richPayload,
    ]);
    expect(genericSend?.[0]).toEqual([]);
    expect(portugueseRichSend?.[0]).toEqual(['showing-pt']);
    expect(portugueseRichSend?.[1]).toEqual({
      ...richPayload,
      title: 'Conexão aceite',
      body: `${SENDER_NAME} aceitou o teu pedido de conexão.`,
    });
  });

  it('sends no Portuguese rich batch when no showing member stored pt', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'showing-en', hidePushPreviews: false, language: 'en' },
      { userId: 'hiding-pt', hidePushPreviews: true, language: 'pt' },
    ]);
    const richPayload = makeRichPayload({
      l10n: {
        titleKey: 'push:mention.title',
        bodyKey: 'push:mention.body',
        params: { name: SENDER_NAME },
      },
    });

    await service.sendSplitByPreviewPreference(
      ['showing-en', 'hiding-pt'],
      richPayload,
    );

    const sentUserIds = (
      pushService.sendToUsers.mock.calls as [string[], PushPayload][]
    ).map(([userIds]) => userIds);
    expect(sentUserIds).toEqual([['showing-en'], [], ['hiding-pt']]);
  });

  it('leaves timestamp and renotify off the locked payload when the rich one has neither', async () => {
    await service.sendSplitByPreviewPreference(
      ['hiding'],
      makeRichPayload({ timestamp: undefined, renotify: undefined }),
    );

    const payload = lockedPayload();
    expect(payload).not.toHaveProperty('timestamp');
    expect(payload).not.toHaveProperty('renotify');
  });

  it('runs the two sends one after the other', async () => {
    let finishRichSend: () => void = () => undefined;
    pushService.sendToUsers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRichSend = resolve;
        }),
    );

    const sending = service.sendSplitByPreviewPreference(
      ['hiding'],
      makeRichPayload(),
    );
    await flushPendingWork();
    expect(pushService.sendToUsers).toHaveBeenCalledTimes(1);

    finishRichSend();
    await sending;
    expect(pushService.sendToUsers).toHaveBeenCalledTimes(2);
  });

  it('still sends the generic payload when the rich send fails, then rethrows', async () => {
    pushService.sendToUsers.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(
      service.sendSplitByPreviewPreference(['hiding'], makeRichPayload()),
    ).rejects.toThrow('pool exhausted');
    expect(pushService.sendToUsers).toHaveBeenCalledTimes(2);
    expect(lockedPayload().title).toBe(GENERIC_PUSH_COPY.notification.title);
  });

  it('rethrows the first failure when both sends fail', async () => {
    pushService.sendToUsers
      .mockRejectedValueOnce(new Error('first fault'))
      .mockRejectedValueOnce(new Error('second fault'));

    await expect(
      service.sendSplitByPreviewPreference(['hiding'], makeRichPayload()),
    ).rejects.toThrow('first fault');
  });

  it('sends nothing at all when the preference lookup fails', async () => {
    preferences.find.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.sendSplitByPreviewPreference(['showing'], makeRichPayload()),
    ).rejects.toThrow('connection reset');
    expect(pushService.sendToUsers).not.toHaveBeenCalled();
  });
});

describe('PushPreviewPrivacyService.sendGenericByLanguage (PRD-325)', () => {
  let service: PushPreviewPrivacyService;
  let preferences: { find: jest.Mock };
  let pushService: { sendToUsers: jest.Mock };

  const basePayload: PushPayload = {
    title: GENERIC_PUSH_COPY.newSignIn.title,
    body: GENERIC_PUSH_COPY.newSignIn.body,
    tag: 'notification:1',
    data: { url: '/account/sessions' },
    l10n: {
      titleKey: GENERIC_PUSH_COPY.newSignIn.titleKey,
      bodyKey: GENERIC_PUSH_COPY.newSignIn.bodyKey,
    },
    timestamp: 1789462800000,
  };

  beforeEach(() => {
    preferences = { find: jest.fn().mockResolvedValue([]) };
    pushService = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    service = new PushPreviewPrivacyService(
      preferences as unknown as Repository<MemberPreferences>,
      pushService as unknown as PushService,
    );
  });

  it('sends nothing and reads no preferences for an empty batch', async () => {
    await service.sendGenericByLanguage(
      [],
      basePayload,
      GENERIC_PUSH_COPY.newSignIn,
    );

    expect(preferences.find).not.toHaveBeenCalled();
    expect(pushService.sendToUsers).not.toHaveBeenCalled();
  });

  it("reads only the batch's language, in one query", async () => {
    await service.sendGenericByLanguage(
      ['first', 'second'],
      basePayload,
      GENERIC_PUSH_COPY.newSignIn,
    );

    expect(preferences.find).toHaveBeenCalledTimes(1);
    expect(preferences.find).toHaveBeenCalledWith({
      where: { userId: In(['first', 'second']) },
      select: { userId: true, language: true },
    });
  });

  it('sends one English batch when nobody stored Portuguese', async () => {
    preferences.find.mockResolvedValue([{ userId: 'english', language: 'en' }]);

    await service.sendGenericByLanguage(
      ['english', 'without-row'],
      basePayload,
      GENERIC_PUSH_COPY.newSignIn,
    );

    expect(pushService.sendToUsers).toHaveBeenCalledTimes(1);
    expect(pushService.sendToUsers).toHaveBeenCalledWith(
      ['english', 'without-row'],
      basePayload,
    );
  });

  it('sends the Portuguese plain fields to pt members and keeps the l10n keys, whatever their preview setting', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'portuguese', language: 'pt' },
      { userId: 'english', language: 'en' },
    ]);

    await service.sendGenericByLanguage(
      ['portuguese', 'english'],
      basePayload,
      GENERIC_PUSH_COPY.newSignIn,
    );

    expect(pushService.sendToUsers).toHaveBeenCalledTimes(2);
    const [englishSend, portugueseSend] = pushService.sendToUsers.mock
      .calls as [string[], PushPayload][];
    expect(englishSend).toEqual([['english'], basePayload]);
    expect(portugueseSend).toEqual([
      ['portuguese'],
      {
        ...basePayload,
        title: 'QueerPulse',
        body: 'Um novo dispositivo iniciou sessão na tua conta.',
      },
    ]);
  });

  it('builds both sends through the lock-screen allowlist', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'portuguese', language: 'pt' },
    ]);

    await service.sendGenericByLanguage(
      ['english', 'portuguese'],
      {
        ...basePayload,
        icon: 'https://images.example/avatars/someone.jpg',
        image: 'https://images.example/previews/photo.jpg',
        actions: [{ action: 'view', title: 'View' }],
        vibrate: [100, 50, 100],
        renotify: true,
        l10n: {
          titleKey: 'push:message.title',
          bodyKey: 'push:message.body',
          params: { name: 'Someone' },
        },
      },
      GENERIC_PUSH_COPY.message,
    );

    const calls = pushService.sendToUsers.mock.calls as [
      string[],
      PushPayload,
    ][];
    expect(calls).toHaveLength(2);
    for (const [, payload] of calls) {
      expect(payload).not.toHaveProperty('icon');
      expect(payload).not.toHaveProperty('image');
      expect(payload).not.toHaveProperty('actions');
      expect(payload).not.toHaveProperty('vibrate');
      expect(payload.renotify).toBe(true);
      expect(payload.l10n).toEqual({
        titleKey: GENERIC_PUSH_COPY.message.titleKey,
        bodyKey: GENERIC_PUSH_COPY.message.bodyKey,
      });
    }
    expect(calls[0]?.[1].body).toBe('You have a new message.');
    expect(calls[1]?.[1].body).toBe('Tens uma mensagem nova.');
  });

  it('skips the English send when every recipient stored Portuguese', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'portuguese', language: 'pt' },
    ]);

    await service.sendGenericByLanguage(
      ['portuguese'],
      basePayload,
      GENERIC_PUSH_COPY.message,
    );

    expect(pushService.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds, payload] = pushService.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(userIds).toEqual(['portuguese']);
    expect(payload.body).toBe('Tens uma mensagem nova.');
  });

  it('still sends the Portuguese batch when the English send fails, then rethrows', async () => {
    preferences.find.mockResolvedValue([
      { userId: 'portuguese', language: 'pt' },
    ]);
    pushService.sendToUsers.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(
      service.sendGenericByLanguage(
        ['english', 'portuguese'],
        basePayload,
        GENERIC_PUSH_COPY.newSignIn,
      ),
    ).rejects.toThrow('pool exhausted');
    expect(pushService.sendToUsers).toHaveBeenCalledTimes(2);
  });
});
