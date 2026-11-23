import type { EntityManager } from 'typeorm';
import {
  COMMUNITY_GIFT_SNAPSHOT_TYPE,
  type CommunityGiftSnapshotEvidence,
} from '../reports/report-evidence';

/** The raw row `COMMUNITY_GIFT_REPORT_SQL` returns. */
interface CommunityGiftReportRow {
  id: string;
  community_id: string;
  gift_key: string;
  note: string | null;
  sender_id: string | null;
  sent_at: Date | string;
}

/** Reads one gift addressed to the filer: `$1` the gift id, `$2` the
 *  recipient. A removed gift stays reportable, so a recipient can still
 *  report a note that staff took down; a gift to anyone else returns no row. */
export const COMMUNITY_GIFT_REPORT_SQL = `SELECT "id", "community_id", "gift_key", "note", "sender_id", "sent_at" FROM "community_gifts" WHERE "id" = $1 AND "recipient_id" = $2`;

/**
 * The evidence snapshot of a gift its recipient is reporting, removed or
 * live, or null when the gift is unknown or addressed to someone other than
 * `reporterId`.
 * The caller answers null with `gift_not_found`, so the filer learns nothing
 * about gifts sent to other members.
 */
export async function captureCommunityGiftForReport(
  manager: Pick<EntityManager, 'query'>,
  giftId: string,
  reporterId: string,
  now: Date,
): Promise<CommunityGiftSnapshotEvidence | null> {
  const rows: CommunityGiftReportRow[] = await manager.query(
    COMMUNITY_GIFT_REPORT_SQL,
    [giftId, reporterId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    type: COMMUNITY_GIFT_SNAPSHOT_TYPE,
    giftId: row.id,
    communityId: row.community_id,
    giftKey: row.gift_key,
    note: row.note,
    senderId: row.sender_id,
    sentAt: new Date(row.sent_at).toISOString(),
    snapshotAt: now.toISOString(),
  };
}
