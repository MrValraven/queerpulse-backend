/**
 * How long one staff member counts as typing for their business after their
 * last `isTyping: true` frame. The composer re-emits `true` about every two
 * seconds while its owner types, and the frontend drops a typing indicator
 * four seconds after the last frame (`useTypingIndicator`'s `TYPING_TTL_MS`),
 * so five seconds outlives one missed refresh and forgets a closed tab soon
 * after the customer's indicator has already faded.
 */
export const MAILBOX_TYPIST_TTL_MS = 5_000;

/**
 * The least time between two `true` frames the business sends while it
 * keeps typing. It matches the composer's own refresh of about two seconds,
 * so the customer's four-second indicator stays up, and one typist and
 * several send the customer the same frames.
 */
export const MAILBOX_TYPING_REFRESH_MS = 2_000;

interface BusinessTypingState {
  typistSeenAtByUserId: Map<string, number>;
  lastRelayedTypingAtMs: number;
}

/**
 * Task 13e: one typing state per business identity per thread. Several staff
 * members of one mailbox may type into the same customer thread at once.
 * Relaying each one's own frames made the customer's indicator flicker, and
 * the number of frames told the customer how many people were typing. The
 * business is typing while ANY of its staff is: `true` is relayed when the
 * business starts typing and then at most once per
 * `MAILBOX_TYPING_REFRESH_MS`, and `false` only once no colleague is still
 * typing. The frames the customer receives are the same for one typist as
 * for several.
 *
 * In-memory and per process, the same single-replica assumption the rest of
 * `ChatGateway` makes.
 */
export class MailboxTypingAggregator {
  private readonly stateByThread = new Map<string, BusinessTypingState>();

  /**
   * Records one staff member's typing frame and returns what the business's
   * frame should say: `true` or `false` to relay, or `null` to relay nothing
   * because the business's state, as the customer sees it, has not changed.
   */
  record(
    conversationId: string,
    identityId: string,
    userId: string,
    isTyping: boolean,
    nowMs: number,
  ): boolean | null {
    const threadKey = `${conversationId}:${identityId}`;
    const state = this.stateByThread.get(threadKey);
    if (state) {
      forgetStaleTypists(state.typistSeenAtByUserId, nowMs);
    }
    const wasBusinessTyping = Boolean(
      state && state.typistSeenAtByUserId.size > 0,
    );
    if (isTyping) {
      const typingState: BusinessTypingState = state ?? {
        typistSeenAtByUserId: new Map(),
        lastRelayedTypingAtMs: 0,
      };
      typingState.typistSeenAtByUserId.set(userId, nowMs);
      this.stateByThread.set(threadKey, typingState);
      const isRefreshDue =
        nowMs - typingState.lastRelayedTypingAtMs >= MAILBOX_TYPING_REFRESH_MS;
      if (!wasBusinessTyping || isRefreshDue) {
        typingState.lastRelayedTypingAtMs = nowMs;
        return true;
      }
      return null;
    }
    if (!state) {
      return null;
    }
    state.typistSeenAtByUserId.delete(userId);
    if (state.typistSeenAtByUserId.size > 0) {
      return null;
    }
    this.stateByThread.delete(threadKey);
    return wasBusinessTyping ? false : null;
  }

  /** Forgets every typist whose last frame is older than the TTL, so a
   *  thread nobody types into again does not keep its entry forever. */
  sweep(nowMs: number): void {
    for (const [threadKey, state] of this.stateByThread) {
      forgetStaleTypists(state.typistSeenAtByUserId, nowMs);
      if (state.typistSeenAtByUserId.size === 0) {
        this.stateByThread.delete(threadKey);
      }
    }
  }
}

function forgetStaleTypists(
  typistSeenAtByUserId: Map<string, number>,
  nowMs: number,
): void {
  for (const [typistUserId, seenAtMs] of typistSeenAtByUserId) {
    if (nowMs - seenAtMs > MAILBOX_TYPIST_TTL_MS) {
      typistSeenAtByUserId.delete(typistUserId);
    }
  }
}
