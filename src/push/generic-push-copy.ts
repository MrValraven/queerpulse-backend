/**
 * What a push says when the recipient has hidden lock-screen previews (ID-13).
 *
 * Every string here has to pass one test: someone reading it over the member's
 * shoulder learns that a QueerPulse notification arrived, and nothing else. No
 * name, no place, no topic, no hint at which part of the platform it came from
 * beyond the coarse category the member needs to decide whether to unlock now.
 *
 * The title is the product name on purpose. It is already on the phone's home
 * screen, so it discloses nothing a bystander could not see anyway, and it is
 * what makes the notification recognisable at a glance instead of anonymous.
 *
 * `titleKey`/`bodyKey` point at `queerpulse/src/pushMessages.ts`, the catalog
 * bundled into the service worker, so an engine that runs the worker localises
 * these. The plain `title`/`body` are the English fallback iOS renders
 * directly, and on iOS they are the ONLY thing rendered, which is the whole
 * reason this file exists rather than the substitution living in `sw.ts`.
 */

export interface GenericPushCopy {
  /** English fallback title: what iOS prints verbatim. */
  title: string;
  /** English fallback body: what iOS prints verbatim. */
  body: string;
  /** Service-worker catalog key for `title`. */
  titleKey: string;
  /** Service-worker catalog key for `body`. */
  bodyKey: string;
  /**
   * The Portuguese title and body, which replace the English fallback for a
   * member whose `member_preferences.language` is `pt` (PRD-325). iOS prints
   * the plain fields verbatim, so this is the only way a Portuguese member's
   * iPhone shows Portuguese. Each string must stay word-for-word the PT value
   * of the matching key in `queerpulse/src/pushMessages.ts`.
   */
  pt: { title: string; body: string };
}

const GENERIC_TITLE = 'QueerPulse';
const GENERIC_TITLE_KEY = 'push:preview.hidden.title';

/**
 * `notification` and `message` are the hidden-preview variants. Calling it a
 * "message" for a DM is the most the copy can say without leaking: it tells
 * the member whether this is worth unlocking for, and a bystander learns only
 * that this platform has messages in it.
 *
 * Add a hidden-preview variant only when the extra specificity genuinely helps
 * the member decide whether to look now. "A community you are in posted" would
 * not: it names a kind of involvement the member may not want named.
 *
 * `newSignIn` and `test` are fixed copies that name nobody, so they are sent
 * as they are to every recipient through
 * `PushPreviewPrivacyService.sendGenericByLanguage`, which picks the English
 * or Portuguese plain fields per recipient (PRD-325).
 */
export const GENERIC_PUSH_COPY = {
  notification: {
    title: GENERIC_TITLE,
    body: 'You have a new notification.',
    titleKey: GENERIC_TITLE_KEY,
    bodyKey: 'push:preview.hidden.body',
    pt: { title: GENERIC_TITLE, body: 'Tens uma notificação nova.' },
  },
  message: {
    title: GENERIC_TITLE,
    body: 'You have a new message.',
    titleKey: GENERIC_TITLE_KEY,
    bodyKey: 'push:preview.hidden.message',
    pt: { title: GENERIC_TITLE, body: 'Tens uma mensagem nova.' },
  },
  // ID-06 / ENG-228: "a new device signed in". The same product-name title a
  // hidden-preview push uses, so the two never drift apart on a lock screen.
  newSignIn: {
    title: GENERIC_TITLE,
    body: 'A new device signed in to your account.',
    titleKey: GENERIC_TITLE_KEY,
    bodyKey: 'push:security.newSignIn.body',
    pt: {
      title: GENERIC_TITLE,
      body: 'Um novo dispositivo iniciou sessão na tua conta.',
    },
  },
  // `POST /push/test`: the member's own check that delivery works.
  test: {
    title: 'Test notification',
    body: 'This is a test. Your notifications are working.',
    titleKey: 'push:test.title',
    bodyKey: 'push:test.body',
    pt: {
      title: 'Notificação de teste',
      body: 'Isto é um teste. As tuas notificações estão a funcionar.',
    },
  },
} as const satisfies Record<string, GenericPushCopy>;
