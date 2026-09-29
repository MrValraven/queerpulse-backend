import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';

/**
 * Re-reads `resolved` under a `pessimistic_read` (FOR SHARE) lock inside the
 * caller's transaction, and refuses with the persona 404 unless it is still
 * followable/endorsable exactly as it was when the caller resolved it:
 * published, `open`, live (`removedAt` null), and on the same link state.
 *
 * Why: `follow` and `endorse` resolve the persona first and write the row
 * after. A linked-to-unlinked switch commits between the two under its own
 * `FOR UPDATE` on the persona row and deletes every follower and endorsement
 * (ENG-447), so an insert that landed after that commit would leave the now
 * pseudonymous persona holding one tie from its named era. FOR SHARE waits for
 * that `FOR UPDATE` to commit, then reads the switched row, and the link-state
 * check refuses the write.
 *
 * The write that follows must run on the same `manager`, so the lock is held
 * until it commits.
 */
export async function lockEngageablePersonaWithin(
  manager: EntityManager,
  resolved: Subprofile,
): Promise<void> {
  const current = await manager.findOne(Subprofile, {
    where: { id: resolved.id },
    lock: { mode: 'pessimistic_read' },
  });
  const isStillEngageable =
    current !== null &&
    current.status === SubprofileStatus.Published &&
    current.visibility === SubprofileVisibility.Open &&
    current.removedAt === null &&
    current.linkVisibility === resolved.linkVisibility;
  if (!isStillEngageable) {
    throw new NotFoundException('Subprofile not found');
  }
}
