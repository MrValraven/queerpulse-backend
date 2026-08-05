import { MemberRef } from '../common/member-ref';
import { initialsFor } from './admin-communities-response';

/**
 * One roster member the admin moderator picker may promote — the plain
 * members (roster role `member`) of a community, i.e. everyone who is on the
 * roster but is not already the owner or a moderator. `userId` is the
 * identity `POST /admin/communities/:slug/moderators` takes as `memberId`.
 */
export interface AdminModeratorCandidateDTO {
  userId: string;
  slug: string;
  name: string;
  initials: string;
}

export function toModeratorCandidate(
  userId: string,
  memberRef: MemberRef,
): AdminModeratorCandidateDTO {
  const name = `${memberRef.firstName} ${memberRef.lastName}`.trim();
  return {
    userId,
    slug: memberRef.slug,
    name,
    initials: initialsFor(name),
  };
}
