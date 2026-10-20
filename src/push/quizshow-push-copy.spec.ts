import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NOTIFICATION_TYPE_CATEGORY,
  NotificationPreferenceCategory,
} from '../notifications/notification-preferences';
import { RICH_PUSH_COPY_PT, localizeRichPayload } from './rich-push-copy';

describe('Pulse Live push category and copy', () => {
  it('lists the Pulse Live switch after last few spots', () => {
    const quizshowIndex = NOTIFICATION_PREFERENCE_CATEGORIES.indexOf(
      NotificationPreferenceCategory.Quizshow,
    );
    const capacityIndex = NOTIFICATION_PREFERENCE_CATEGORIES.indexOf(
      NotificationPreferenceCategory.EventCapacity,
    );
    expect(quizshowIndex).toBeGreaterThan(-1);
    expect(quizshowIndex).toBe(capacityIndex + 1);
  });

  it('maps no notification type to it', () => {
    expect(Object.values(NOTIFICATION_TYPE_CATEGORY)).not.toContain(
      NotificationPreferenceCategory.Quizshow,
    );
  });

  it('renders the Portuguese copy with the event and the code', () => {
    const localized = localizeRichPayload(
      {
        title: 'Pulse Live is starting',
        body: 'The live game is starting',
        tag: 'quizshow:starting',
        data: { url: '/events' },
        l10n: {
          titleKey: 'push:quizshow.starting.title',
          bodyKey: 'push:quizshow.starting.body',
          params: { event: 'Quiz da Lua', code: 'ABC234' },
        },
      },
      RICH_PUSH_COPY_PT,
    );
    expect(localized.title).toBe('O Pulse Live está a começar');
    expect(localized.body).toBe(
      'O jogo ao vivo de Quiz da Lua está a começar, entra com o código ABC234',
    );
  });
});
