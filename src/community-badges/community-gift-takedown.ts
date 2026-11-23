import { EntityManager } from 'typeorm';
import {
  CommunityGovernanceLog,
  GovernanceLogAction,
} from '../communities/entities/community-governance-log.entity';
import { writeGovernanceLogEntry } from '../communities/community-governance-log.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { COMMUNITY_GIFT_SUBJECT_TYPE } from './community-badges.constants';

/** Matches the textual form of a uuid, so a malformed id never reaches a `uuid` cast. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes one gift for a platform takedown. `$1` the gift id, `$2` the
 * moderator. A gift that is already removed matches nothing and returns no row,
 * so the takedown writes no second governance entry.
 */
export const REMOVE_GIFT_ON_TAKEDOWN_SQL = `WITH "removed" AS (
  UPDATE "community_gifts" SET "removed_at" = now(), "removed_by_id" = $2
  WHERE "id" = $1::uuid AND "removed_at" IS NULL
  RETURNING "id", "community_id", "recipient_id", "gift_key"
)
SELECT "id", "community_id", "recipient_id", "gift_key" FROM "removed"`;

/**
 * Drops the note from the recipient's `community_gift_received` notification of
 * one gift, so a removed gift's note leaves the bell along with the gift.
 * `$1` the gift id, `$2` the recipient. The payload is `jsonb`; a row that
 * already has no note is left as it is.
 */
export const SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL = `UPDATE "notifications" SET "payload" = "payload" - 'note' WHERE "type" = '${NotificationType.CommunityGiftReceived}' AND "user_id" = $2 AND "payload" ->> 'giftId' = $1 AND "payload" ? 'note'`;

/** Scrub the note of one removed gift from its recipient's notification, on
 * the transaction that removes the gift. */
export async function scrubGiftNoteFromRecipientNotification(
  manager: Pick<EntityManager, 'query'>,
  giftId: string,
  recipientId: string,
): Promise<void> {
  await manager.query(SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL, [
    giftId,
    recipientId,
  ]);
}

interface RemovedGiftRow {
  id: string;
  community_id: string;
  recipient_id: string;
  gift_key: string;
}

/**
 * The takedown hook `ContentModerationService.applyAction` calls inside the
 * moderation transaction. It returns at once unless the subject is a gift with
 * a well formed id. A removed gift gets one `gift_removed` governance entry
 * that leaves both actor and target empty and sets `adminOverride: true`:
 * only the recipient can report a gift, so naming them would tell staff who
 * filed. The entry carries no note, and the note leaves the recipient's
 * notification in the same transaction. Runs for `hide_content` and `remove_content` alike.
 */
export async function removeCommunityGiftOnTakedown(
  manager: EntityManager,
  subjectType: string,
  subjectId: string,
  actorId: string | null,
): Promise<void> {
  if (
    subjectType !== COMMUNITY_GIFT_SUBJECT_TYPE ||
    !UUID_PATTERN.test(subjectId)
  ) {
    return;
  }
  const removedRows: RemovedGiftRow[] = await manager.query(
    REMOVE_GIFT_ON_TAKEDOWN_SQL,
    [subjectId, actorId],
  );
  const removedGift = removedRows[0];
  if (!removedGift) return;
  await scrubGiftNoteFromRecipientNotification(
    manager,
    removedGift.id,
    removedGift.recipient_id,
  );
  await writeGovernanceLogEntry(manager.getRepository(CommunityGovernanceLog), {
    communityId: removedGift.community_id,
    actorUserId: null,
    action: GovernanceLogAction.GiftRemoved,
    targetUserId: null,
    metadata: {
      giftId: removedGift.id,
      giftKey: removedGift.gift_key,
      adminOverride: true,
    },
  });
}
