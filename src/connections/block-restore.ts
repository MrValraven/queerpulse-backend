import { EntityManager } from 'typeorm';
import {
  Connection,
  ConnectionStatus,
  RestoredConnectionStatus,
  toRestoredConnectionStatus,
} from './entities/connection.entity';

/**
 * PRD-363: the one definition of "block severs a connection" and "unblock
 * restores it", shared by both entry points (`SocialService.blockMember` /
 * `unblockMember` and `ConnectionsService.respond('block' | 'unblock')`) so the
 * two buttons can never disagree about what an undo gives back.
 *
 * Both are single conditional UPDATEs run inside the caller's transaction. In
 * SQL every right-hand side reads the row as it was before the statement, so
 * the stash columns capture the pre-block `status` / `responded_at` in the same
 * write that overwrites them, with no read-then-write window.
 */

/** Keeps the prior status only when it is worth restoring. */
const STATUS_BEFORE_BLOCK_SQL = `CASE WHEN "status" IN ('${ConnectionStatus.Accepted}', '${ConnectionStatus.Pending}') THEN "status" ELSE NULL END`;

const RESPONDED_AT_BEFORE_BLOCK_SQL = `CASE WHEN "status" IN ('${ConnectionStatus.Accepted}', '${ConnectionStatus.Pending}') THEN "responded_at" ELSE NULL END`;

/**
 * Sever the pair's connection row for a block by `blockerId`. Matches only a
 * row that is not already `blocked`, so a block the OTHER member placed is
 * never seized (and its stash is never overwritten). Returns the affected row
 * count (0 or 1) so a caller can tell "severed now" from "already blocked".
 *
 * A 0 here is NOT a lost block. The second blocker's own `blocks` row is
 * written either way, and {@link restoreConnectionAfterUnblock} hands the
 * connection row (stash included) to whichever block still stands when the
 * first blocker lifts theirs, so the second member's unblock is what finally
 * restores the pair. The count is returned rather than discarded so a caller
 * that must REFUSE on an already-blocked row (`ConnectionsService.respond`,
 * where seizing the other member's block would be an escape hatch) can tell
 * the two cases apart.
 */
export async function severConnectionForBlock(
  manager: EntityManager,
  pair: { low: string; high: string },
  blockerId: string,
  respondedAt: Date,
): Promise<number> {
  const result = await manager
    .createQueryBuilder()
    .update(Connection)
    .set({
      status: ConnectionStatus.Blocked,
      blockedBy: blockerId,
      respondedAt,
      statusBeforeBlock: () => STATUS_BEFORE_BLOCK_SQL,
      respondedAtBeforeBlock: () => RESPONDED_AT_BEFORE_BLOCK_SQL,
    })
    .where('"user_low" = :low AND "user_high" = :high', pair)
    .andWhere('"status" != :blocked', { blocked: ConnectionStatus.Blocked })
    .execute();
  return result.affected ?? 0;
}

/**
 * Does a block placed by the OTHER member against the unblocker still stand?
 * `$3` is the unblocker, `$4` the other member of the pair. Only that one
 * direction is read, because the unblocker's own `blocks` row is deleted in
 * the same transaction as this call and the two entry points delete it on
 * opposite sides of the restore (`SocialService.unblockMember` before,
 * `ConnectionsService.respond('unblock')` after).
 */
const OTHER_BLOCK_STANDS_SQL = `EXISTS (
  SELECT 1 FROM "blocks" surviving_block
  WHERE surviving_block."blocker_id" = $4 AND surviving_block."blocked_id" = $3
)`;

/**
 * Lift `unblockerId`'s block on the pair's connection row.
 *
 * WHEN NO BLOCK SURVIVES, put back what the block took: `accepted` stays
 * `accepted` (with its original `responded_at`), `pending` goes back to
 * `pending` with the original requester and a NULL `responded_at`. A row with
 * nothing stashed (it was `declined`, or the block predates the stash columns)
 * returns to `declined` exactly as before. The stash is cleared either way.
 *
 * WHEN THE OTHER MEMBER'S BLOCK STILL STANDS, the row is HANDED OVER instead:
 * it stays `blocked`, `blocked_by` becomes the other member, and the stash is
 * kept untouched so THEIR unblock is what finally restores the pair. Without
 * this the row went back to `accepted` while a live block stood, which every
 * connection-derived read (`areConnected`, the connection lists, the reply
 * gate) then believed — and the other member's own unblock, finding
 * `blocked_by` no longer theirs, restored nothing. Only one row can name one
 * blocker, so the handover is how the second block keeps its claim. This is
 * the behaviour `connection.entity.ts`'s `RestoredConnectionStatus` doc has
 * always promised.
 *
 * Conditional on `blocked_by = unblockerId`, so a block the other member placed
 * is never lifted by the wrong person. No matching row (a block placed on a
 * stranger, or on a pair whose row was since removed) restores nothing. The
 * handover leaves the row `blocked`, which {@link toRestoredConnectionStatus}
 * reports as `none` — an honest "nothing came back".
 *
 * One statement: every right-hand side reads the row as it was before the
 * write, so the stash is carried over in the same UPDATE that rewrites
 * `blocked_by`, with no read-then-write window for a concurrent unblock.
 */
export async function restoreConnectionAfterUnblock(
  manager: EntityManager,
  pair: { low: string; high: string },
  unblockerId: string,
): Promise<RestoredConnectionStatus> {
  const otherMemberId = pair.low === unblockerId ? pair.high : pair.low;
  const rows: Array<{ status: ConnectionStatus }> = await manager.query(
    `UPDATE "connections" SET
       "status" = CASE
         WHEN ${OTHER_BLOCK_STANDS_SQL} THEN "status"
         ELSE COALESCE("status_before_block", '${ConnectionStatus.Declined}')
       END,
       "responded_at" = CASE
         WHEN ${OTHER_BLOCK_STANDS_SQL} THEN "responded_at"
         WHEN "status_before_block" IS NULL THEN "responded_at"
         ELSE "responded_at_before_block"
       END,
       "blocked_by" = CASE
         WHEN ${OTHER_BLOCK_STANDS_SQL} THEN $4::uuid
         ELSE NULL
       END,
       "status_before_block" = CASE
         WHEN ${OTHER_BLOCK_STANDS_SQL} THEN "status_before_block"
         ELSE NULL
       END,
       "responded_at_before_block" = CASE
         WHEN ${OTHER_BLOCK_STANDS_SQL} THEN "responded_at_before_block"
         ELSE NULL
       END
     WHERE "user_low" = $1
       AND "user_high" = $2
       AND "status" = '${ConnectionStatus.Blocked}'
       AND "blocked_by" = $3
     RETURNING "status"`,
    [pair.low, pair.high, unblockerId, otherMemberId],
  );
  return toRestoredConnectionStatus(rows[0]?.status);
}
