import type { IdentityKind } from '../identities/entities/identity.entity';
import type { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import type { MessageReactionKey } from '../messaging/entities/message-reaction.entity';
import {
  describeDirectThreadSeats,
  isStaffSeatExcludedByBlock,
  NO_MAILBOX_IDENTITY_BLOCKS,
} from '../messaging/mailbox-seats';
import type { MessageReactionCount } from '../messaging/messaging.events';

/**
 * Task 13e: which of a newly blocked pair loses their live place in one
 * direct thread they share. `threadSeats` is every seat of that thread.
 *
 * Each of the pair is judged by `isStaffSeatExcludedByBlock` from their own
 * seat, so the answer is the same one the REST surfaces give: a staff member
 * blocked with the customer is evicted, the customer stays, and a block
 * between two colleagues changes nothing. A thread with any seat whose
 * identity did not resolve cannot be judged, and evicts both of the pair,
 * which is the answer an ordinary DM gets.
 *
 * Task 14: the question is what this one person block changes, so no
 * identity block is read here. A customer's block of a whole business has
 * its own eviction, `ChatGateway.handleIdentityBlocked`.
 */
export function blockedPairUserIdsToEvict(
  threadSeats: ReadonlyArray<ConversationParticipant>,
  identityKindById: ReadonlyMap<string, IdentityKind>,
  pairUserIds: readonly [string, string],
): string[] {
  const isEverySeatResolved = threadSeats.every((seat) =>
    identityKindById.has(seat.identityId),
  );
  return pairUserIds.filter((userId, index) => {
    const ownSeat = threadSeats.find((seat) => seat.userId === userId);
    if (!ownSeat) {
      return false;
    }
    if (!isEverySeatResolved) {
      return true;
    }
    const otherUserId = pairUserIds[index === 0 ? 1 : 0];
    return isStaffSeatExcludedByBlock(
      describeDirectThreadSeats(
        ownSeat.identityId,
        threadSeats.filter((seat) => seat !== ownSeat),
        identityKindById,
      ),
      new Set([otherUserId]),
      NO_MAILBOX_IDENTITY_BLOCKS,
    );
  });
}

/**
 * Task 13e: one count per key of `keyOrder`, in its order, counting
 * `reactionRows`. The live `reaction` frame passes rows already collapsed by
 * `collapseBusinessReactions`, so the customer's counts are the ones their
 * REST read of the same message gives.
 */
export function countReactionsPerKey(
  keyOrder: ReadonlyArray<MessageReactionCount>,
  reactionRows: ReadonlyArray<{ key: MessageReactionKey }>,
): MessageReactionCount[] {
  return keyOrder.map(({ key }) => ({
    key,
    count: reactionRows.filter((row) => row.key === key).length,
  }));
}

/** The latest of `values`, ignoring nulls, or null when there is none. */
export function latestTimestamp(
  values: ReadonlyArray<Date | null | undefined>,
): Date | null {
  return values.reduce<Date | null>(
    (latest, value) => (value && (!latest || value > latest) ? value : latest),
    null,
  );
}
