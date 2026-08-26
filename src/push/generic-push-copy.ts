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
}

const GENERIC_TITLE = 'QueerPulse';
const GENERIC_TITLE_KEY = 'push:preview.hidden.title';

/**
 * The two variants in use. Saying "message" rather than "notification" for a DM
 * is the most the copy can narrow without leaking: it tells the member whether
 * this is worth unlocking for, and a bystander learns only that this platform
 * has messages in it.
 *
 * Add a variant only when the extra specificity genuinely helps the member
 * decide whether to look now. "A community you are in posted" would not: it
 * names a kind of involvement the member may not want named.
 */
export const GENERIC_PUSH_COPY = {
  notification: {
    title: GENERIC_TITLE,
    body: 'You have a new notification.',
    titleKey: GENERIC_TITLE_KEY,
    bodyKey: 'push:preview.hidden.body',
  },
  message: {
    title: GENERIC_TITLE,
    body: 'You have a new message.',
    titleKey: GENERIC_TITLE_KEY,
    bodyKey: 'push:preview.hidden.message',
  },
} as const satisfies Record<string, GenericPushCopy>;
