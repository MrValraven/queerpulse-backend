import {
  SubprofileKind,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';

/**
 * One row of "the personas I follow" (`GET /subprofiles/following`).
 *
 * Hand-mapped from `Subprofile` + `SubprofileFollower`, because there is no
 * global serializer and the entity carries columns this list has no business
 * shipping (`userId`, `bio`, every skin blob, the moderation timestamps).
 *
 * ADDRESS FIELDS, AND THE ANONYMITY RULE THEY CARRY. A persona has exactly two
 * possible public addresses and the client builds the link from these three
 * fields alone (`personaOwnerAddress` in `personaLinks.data.ts` is the only
 * sanctioned builder):
 *  - LINKED  -> `/members/<ownerSlug>/<slug>`, where `ownerSlug` is the
 *    CREATOR's profile slug, never the viewer's and never a co-owner's.
 *  - UNLINKED -> `/p/<handle>`.
 *
 * `ownerSlug` is therefore populated for LINKED personas ONLY and is `null` for
 * every unlinked one, matching `SubprofileCardDTO` in the directory: a
 * pseudonymous persona never discloses who is behind it, and a list of what one
 * member follows is exactly the surface where a leak would be cheap to harvest.
 *
 * Either field can be `null` on a persona whose address cannot be resolved (a
 * linked persona whose creator profile row has gone). The client renders that
 * row without a link rather than fabricating one, because a fabricated
 * `/p/<slug>` is a dead link a member only discovers weeks later.
 */
export interface FollowedPersonaView {
  /** The persona id, the key the unfollow route takes. */
  id: string;
  displayName: string;
  kind: SubprofileKind;
  tagline: string | null;
  avatarUrl: string | null;
  accent: string | null;
  /** The persona's per-owner slug, the second segment of the nested address. */
  slug: string;
  /** The global handle of an unlinked persona, `null` for a linked one. */
  handle: string | null;
  linkVisibility: SubprofileLinkVisibility;
  /** The CREATOR's profile slug. LINKED personas only, else `null`. */
  ownerSlug: string | null;
  /** Total followers, so the row can say how many others are listening. */
  followerCount: number;
  /** When THIS viewer started following, newest first in the list. */
  followedAt: Date;
}
