import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import {
  EntryStatus,
  EventMatchEntry,
} from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';

/**
 * Entry writes that race member actions. A member can withdraw, leave or be
 * moved between the moment formation reads their entry and the moment it
 * writes it, so every seating write is guarded on the state that was read,
 * and only the entries the write actually changed get a chat seat or a
 * notification.
 */

/** Seated members keyed by their current group; pending ones under null. */
function bySeatedGroup(
  members: EventMatchEntry[],
): Map<string | null, EventMatchEntry[]> {
  const buckets = new Map<string | null, EventMatchEntry[]>();
  for (const member of members) {
    const key = member.status === 'grouped' ? member.groupId : null;
    const bucket = buckets.get(key) ?? [];
    bucket.push(member);
    buckets.set(key, bucket);
  }
  return buckets;
}

/**
 * Which of `candidates` a guarded update changed. When `affected` covers all
 * of them (or none), no read is needed; otherwise the rows are re-read
 * against `confirmWhere`.
 */
export async function confirmChanged(
  entries: Repository<EventMatchEntry>,
  candidates: EventMatchEntry[],
  affected: number | undefined,
  confirmWhere: FindOptionsWhere<EventMatchEntry>,
): Promise<EventMatchEntry[]> {
  if (affected === candidates.length) return candidates;
  if (affected === 0) return [];
  const changedRows = await entries.find({
    where: {
      ...confirmWhere,
      id: In(candidates.map((candidate) => candidate.id)),
    },
    select: { id: true },
  });
  const changedIds = new Set(changedRows.map((changedRow) => changedRow.id));
  return candidates.filter((candidate) => changedIds.has(candidate.id));
}

/**
 * The guarded `grouped` write every seating path shares. Each entry must
 * still hold one of `fromStatuses` and, when it was seated, the group it had
 * when it was read. A pending invite a seated member sent ends here: the
 * friend can no longer join them, so neither card keeps showing it. Returns
 * the entries the write actually changed.
 */
export async function guardedMoveIntoGroup(
  entries: Repository<EventMatchEntry>,
  members: EventMatchEntry[],
  groupId: string,
  fromStatuses: EntryStatus[],
): Promise<EventMatchEntry[]> {
  if (members.length === 0) return [];
  let affected: number | undefined = 0;
  for (const [seatedGroupId, sameGroup] of bySeatedGroup(members)) {
    const result = await entries.update(
      {
        id: In(sameGroup.map((member) => member.id)),
        status: In(fromStatuses),
        ...(seatedGroupId === null ? {} : { groupId: seatedGroupId }),
      },
      {
        status: 'grouped',
        groupId,
        unmatchedNotifiedAt: null,
        mergeOfferGroupId: null,
      },
    );
    affected =
      affected === undefined || result.affected === undefined
        ? undefined
        : affected + result.affected;
  }
  const moved = await confirmChanged(entries, members, affected, {
    status: 'grouped',
    groupId,
  });
  const invitingIds = moved
    .filter((member) => member.pairStatus === 'pending')
    .map((member) => member.id);
  if (invitingIds.length > 0) {
    await entries.update(
      { id: In(invitingIds), pairStatus: 'pending' },
      { pairStatus: 'none', pairPartnerId: null },
    );
  }
  return moved;
}

/**
 * ENG-432: the seating write into a group that already exists (a merge, a
 * late joiner, a move after a block). The seat count and the move share one
 * transaction that first locks the target group row `FOR NO KEY UPDATE`
 * (`for_no_key_update`), so two writers aiming at the same group run one
 * after the other: the second one counts the seats the first one just took.
 * That mode also holds off a concurrent dissolve, and it leaves the
 * `FOR KEY SHARE` lock that the foreign keys on `event_match_entries`
 * (`group_id`, `merge_offer_group_id`) take on this row free, so a merge
 * offer written to an entry meanwhile cannot deadlock against this write. The whole unit moves
 * only while it fits under `maxSize` together and the group is still open;
 * otherwise nobody moves and the result is empty. Chat seats and
 * notifications stay with the caller, after the commit.
 */
export async function guardedMoveIntoOpenGroup(
  entries: Repository<EventMatchEntry>,
  members: EventMatchEntry[],
  groupId: string,
  fromStatuses: EntryStatus[],
  maxSize: number,
): Promise<EventMatchEntry[]> {
  if (members.length === 0) return [];
  return entries.manager.transaction(async (manager) => {
    const lockedGroup = await manager.findOne(EventMatchGroup, {
      where: { id: groupId, dissolvedAt: IsNull() },
      lock: { mode: 'for_no_key_update' },
    });
    if (!lockedGroup) return [];
    const seatedCount = await manager.count(EventMatchEntry, {
      where: { groupId, status: 'grouped' },
    });
    if (seatedCount + members.length > maxSize) return [];
    return guardedMoveIntoGroup(
      manager.getRepository(EventMatchEntry),
      members,
      groupId,
      fromStatuses,
    );
  });
}
