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
      select: { userId: true, hidePushPreviews: true },
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
