import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';

/**
 * One message in a piece's editor↔writer thread (Magazine Desk Phase 7,
 * Task F1), hand-mapped from `MagazinePieceMessage` — `author` is a resolved
 * display name (editor directory ∪ Profile, same batched lookup as
 * `MagazinePieceService.listMagazineNotifications`/`listArticleComments`),
 * NEVER a raw `authorId`/email. `fromMe` is computed server-side against the
 * REQUESTING user's id (never trusting a client-supplied "is this mine" flag)
 * so the frontend can align own-vs-other bubbles without ever receiving a raw
 * user id to compare against.
 */
export interface PieceMessageResponse {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  fromMe: boolean;
}

/**
 * Neutral fallback — NEVER an email or raw uuid (mirrors
 * `magazine-article-comment-response.ts`'s `UNRESOLVED_COMMENT_AUTHOR_LABEL`).
 * Reached only when a message's `authorId` isn't in the caller's resolved
 * name map, which shouldn't happen for any real account (defensive).
 */
export const UNRESOLVED_MESSAGE_AUTHOR_LABEL = 'Someone on the team';

/**
 * Pure mapper from one persisted `MagazinePieceMessage` to its response
 * shape. `authorNameById` is resolved by the caller (batched editor
 * directory ∪ `Profile` lookup) so this stays a pure function of its inputs.
 */
export function toPieceMessage(
  message: MagazinePieceMessage,
  authorNameById: Map<string, string>,
  requestingUserId: string,
): PieceMessageResponse {
  return {
    id: message.id,
    author:
      authorNameById.get(message.authorId) ?? UNRESOLVED_MESSAGE_AUTHOR_LABEL,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    fromMe: message.authorId === requestingUserId,
  };
}
