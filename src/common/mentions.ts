export interface ExtractedMentions {
  members: string[];
  communities: string[];
  businesses: string[];
  events: string[];
  threads: string[];
}

// `@slug`, `c/slug`, `b/slug`, `e/slug`, `t/slug` at a boundary (string start or
// after whitespace). The boundary guard keeps `me@host.com` / `.../c/x` plain.
// Topics (`#`) are intentionally excluded — a topic has no owner to notify.
const MENTION_TOKEN = /(?:^|\s)(@|c\/|b\/|e\/|t\/)([a-z0-9][a-z0-9-]*)/g;

const BUCKET_BY_SIGIL: Record<string, keyof ExtractedMentions> = {
  '@': 'members',
  'c/': 'communities',
  'b/': 'businesses',
  'e/': 'events',
  't/': 'threads',
};

export function extractMentions(body: string): ExtractedMentions {
  const result: ExtractedMentions = {
    members: [],
    communities: [],
    businesses: [],
    events: [],
    threads: [],
  };
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const sigil = match[1];
    const slug = match[2];
    if (sigil === undefined || slug === undefined) continue;
    const bucketKey = BUCKET_BY_SIGIL[sigil];
    if (bucketKey === undefined) continue;
    const bucket = result[bucketKey];
    if (!bucket.includes(slug)) bucket.push(slug);
  }
  return result;
}

/**
 * Message kinds whose `body` is the sending client's localized fallback label
 * ("Photo", "Document", "GIF"; a sticker is stored with an empty `body`) and
 * whose member-typed words, if any, live in `attachment.caption`. The one
 * list every mention reader of a chat message shares: the send-time fan-out
 * (`MessagesService`), the inbox's unread-mention flag
 * (`MessagingCoreService`) and the group push (`PushListener`).
 */
export const CAPTIONED_MESSAGE_KINDS: readonly string[] = [
  'gif',
  'image',
  'document',
  'sticker',
];

/**
 * The text of a chat message that can carry mentions. A captioned kind
 * contributes its caption, or '' when the member typed none; every other
 * kind contributes its `body`. A sticker attachment has no `caption` key, so
 * it always contributes ''.
 */
export function messageMentionText(message: {
  kind: string;
  body: string;
  attachment: object | null;
}): string {
  if (!CAPTIONED_MESSAGE_KINDS.includes(message.kind)) {
    return message.body;
  }
  const attachment = message.attachment;
  if (
    attachment &&
    'caption' in attachment &&
    typeof attachment.caption === 'string'
  ) {
    return attachment.caption;
  }
  return '';
}

/** Member slugs only — back-compat for existing callers/tests. */
export function extractMentionSlugs(body: string): string[] {
  return extractMentions(body).members;
}
