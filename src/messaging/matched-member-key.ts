import { createHmac, randomBytes } from 'crypto';
import { apiUrlFor } from '../common/image-url';

/**
 * PRD-423 (opaque member keys): how a member of a matched Go together chat is
 * referred to inside that chat.
 *
 * A matched chat seats strangers who only see each other's first names until
 * they choose otherwise. A profile slug usually spells the full name, and a
 * user id is a stable handle onto the person everywhere else on the platform,
 * so neither may reach the other members. Every member reference the chat
 * hands out (author summaries, the roster and its preview, system events,
 * stored `@` mention tokens, live socket frames) is instead this key: stable
 * for one (chat, member) pair, different in every other chat, and impossible
 * to walk back to the person without the server secret.
 *
 * The key is the same for every viewer, so a frame rendered once and
 * broadcast to the whole room stays correct, and the frontend recognises its
 * own messages by the `viewerMemberKey` its conversation read carries.
 *
 * Its alphabet is the mention tokenizer's slug alphabet (`[a-z0-9-]`, see
 * `common/mentions.ts`), so a member picked from the chat's `@` picker is
 * stored in the message body as `@m-<hex>` and parsed back by the same
 * extractor every other mention uses.
 *
 * Nothing is stored. A key is recomputed on every read, and resolved back by
 * recomputing the keys of the conversation's own seats and matching, so a
 * key is only ever meaningful inside the conversation it was minted for.
 */

/** The prefix every member key carries, so a key never reads as a slug. */
export const MATCHED_MEMBER_KEY_PREFIX = 'm-';

/** 24 hex characters: 96 bits of the HMAC, far past any guessing. */
const MATCHED_MEMBER_KEY_HEX_LENGTH = 24;

const MATCHED_MEMBER_KEY_PATTERN = new RegExp(
  `^${MATCHED_MEMBER_KEY_PREFIX}[0-9a-f]{${MATCHED_MEMBER_KEY_HEX_LENGTH}}$`,
);

/** Domain separation: the server secret may be shared with token signing,
 *  so this purpose derives its own key from it and uses that key alone. */
const MATCHED_MEMBER_KEY_PURPOSE = 'queerpulse:matched-chat-member-key:v1';

let derivedMemberKeySecret: Buffer | null = null;

/**
 * The HMAC key, derived once per process. `MATCHED_MEMBER_KEY_SECRET` wins
 * when set (optional, validated at boot to at least 32 characters), which
 * decouples the keys from JWT rotation; otherwise it is derived from
 * `JWT_ACCESS_SECRET` (required at boot). Either way the keys stay stable
 * across restarts, so stored `@` mentions keep resolving, and changing the
 * secret in use re-keys every matched chat: earlier mention tokens then
 * render as their raw text. A process with neither secret refuses to mint a
 * key, except under `NODE_ENV=test`, where a random per-process value keeps
 * every key stable for that process's life.
 */
function memberKeySecret(): Buffer {
  if (!derivedMemberKeySecret) {
    const serverSecret =
      process.env.MATCHED_MEMBER_KEY_SECRET || process.env.JWT_ACCESS_SECRET;
    if (!serverSecret && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'MATCHED_MEMBER_KEY_SECRET or JWT_ACCESS_SECRET must be set to mint matched chat member keys',
      );
    }
    derivedMemberKeySecret = createHmac(
      'sha256',
      serverSecret || randomBytes(32).toString('hex'),
    )
      .update(MATCHED_MEMBER_KEY_PURPOSE)
      .digest();
  }
  return derivedMemberKeySecret;
}

/** The opaque key `userId` is known by inside matched chat `conversationId`. */
export function matchedChatMemberKey(
  conversationId: string,
  userId: string,
): string {
  const digest = createHmac('sha256', memberKeySecret())
    .update(`${conversationId}:${userId}`)
    .digest('hex');
  return `${MATCHED_MEMBER_KEY_PREFIX}${digest.slice(0, MATCHED_MEMBER_KEY_HEX_LENGTH)}`;
}

/** Whether `value` has the shape of a member key (it may still name nobody
 *  in a given conversation; only {@link resolveMatchedChatMemberKeys} says). */
export function isMatchedChatMemberKey(value: string | null | undefined) {
  return !!value && MATCHED_MEMBER_KEY_PATTERN.test(value);
}

/**
 * Resolves `memberKeys` back to user ids, among `seatUserIds` (the
 * conversation's own seats, current and former, as the caller's read gate
 * allows). A key that names none of them is left out, so a key minted for
 * another chat, or a guess, resolves to nobody.
 */
export function resolveMatchedChatMemberKeys(
  conversationId: string,
  seatUserIds: Iterable<string>,
  memberKeys: Iterable<string>,
): Map<string, string> {
  const wantedKeys = new Set(
    [...memberKeys].filter((memberKey) => isMatchedChatMemberKey(memberKey)),
  );
  const userIdByKey = new Map<string, string>();
  if (!wantedKeys.size) return userIdByKey;
  for (const userId of new Set(seatUserIds)) {
    const memberKey = matchedChatMemberKey(conversationId, userId);
    if (wantedKeys.has(memberKey)) userIdByKey.set(memberKey, userId);
  }
  return userIdByKey;
}

/** A stored `@<member key>` token at a mention boundary, the same boundary
 *  rule `extractMentions` applies (`common/mentions.ts`). */
const MATCHED_MEMBER_MENTION = /(^|\s)@(m-[0-9a-f]{24})(?=[^a-z0-9-]|$)/g;

/** Whether `text` carries any `@<member key>` token at all, so a caller can
 *  skip the seat and profile reads {@link renderMatchedChatMentions} needs. */
export function hasMatchedChatMentions(text: string | null | undefined) {
  return !!text && new RegExp(MATCHED_MEMBER_MENTION.source).test(text);
}

/** The `@<member key>` tokens `text` carries, de-duplicated. */
export function matchedChatMentionKeys(text: string | null | undefined) {
  if (!text) return [];
  return [
    ...new Set(
      [...text.matchAll(MATCHED_MEMBER_MENTION)].map((match) => match[2]!),
    ),
  ];
}

/** What a member key no seat of the chat answers to reads as. */
const UNNAMED_MEMBER_LABEL = 'Member';

/**
 * PRD-423 (opaque member keys): `text` with every stored `@<member key>`
 * token spelled `@FirstName`, for copy read outside the open chat (a push
 * body, a Mentions inbox excerpt, a search or starred snippet). Keys
 * resolve among `seatUserIds` (the chat's own seats) to
 * `firstNameByUserId`; a key naming nobody there reads as `@Member`. The
 * stored body itself is never rewritten.
 */
export function renderMatchedChatMentions(
  text: string,
  conversationId: string,
  seatUserIds: Iterable<string>,
  firstNameByUserId: ReadonlyMap<string, string>,
): string {
  const memberKeys = matchedChatMentionKeys(text);
  if (!memberKeys.length) return text;
  const userIdByKey = resolveMatchedChatMemberKeys(
    conversationId,
    seatUserIds,
    memberKeys,
  );
  return text.replace(
    MATCHED_MEMBER_MENTION,
    (_token, boundary: string, memberKey: string) => {
      const userId = userIdByKey.get(memberKey);
      const firstName = userId ? firstNameByUserId.get(userId)?.trim() : '';
      return `${boundary}@${firstName || UNNAMED_MEMBER_LABEL}`;
    },
  );
}

/** The VERSION_NEUTRAL route `MatchedChatAvatarController` serves a matched
 *  chat member's avatar at. */
export const MATCHED_CHAT_AVATAR_ROUTE = 'matched-chat-avatars';

/**
 * PRD-423 (opaque member keys): the avatar URL a matched Go together chat
 * hands out for a member whose photo is visible, addressed by conversation
 * and member key, so neither the storage key (which names the uploader's
 * user id) nor an external provider URL reaches the other members. The same
 * URL for every viewer, so one broadcast serves the room. `version` changes
 * with the stored avatar (a keyed digest of it, revealing nothing), so a
 * new photo is never served from a stale cache.
 */
export function matchedChatAvatarUrl(
  conversationId: string,
  userId: string,
  storedAvatar: string,
): string {
  const memberKey = matchedChatMemberKey(conversationId, userId);
  const version = matchedChatMemberKey(conversationId, storedAvatar).slice(
    MATCHED_MEMBER_KEY_PREFIX.length,
    MATCHED_MEMBER_KEY_PREFIX.length + 8,
  );
  return apiUrlFor(
    `${MATCHED_CHAT_AVATAR_ROUTE}/${conversationId}/${memberKey}?v=${version}`,
  );
}
