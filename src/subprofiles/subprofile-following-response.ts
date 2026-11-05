import { Paginated } from '../common/pagination';
import { SubprofileCardView } from './subprofile-response';

/**
 * One row of "the personas I follow" (`GET /subprofiles/following`).
 *
 * The directory's portrait card (`SubprofileCardView`, drawn by
 * `SubprofilePublicReadService.buildCardsFor`) plus when this viewer followed.
 * The Following tab renders the same card as the directory's Everyone tab, so
 * the row carries everything that card draws: banner and both crops,
 * availability, tags, social and follower counts, credits, the Quest "At the
 * table" summary and the viewer's own follow and co-owner state. The row is
 * built from the card itself: the entity carries columns this list has no
 * business shipping (`userId`, `bio`, every skin blob, the moderation
 * timestamps), and a second mapper would drift from the card it has to match.
 *
 * ADDRESS FIELDS, AND THE ANONYMITY RULE THEY CARRY. A persona has exactly two
 * possible public addresses and the client builds the link from these three
 * fields alone (`personaOwnerAddress` in `personaLinks.data.ts` is the only
 * sanctioned builder):
 *  - LINKED  -> `/p/<handle>`, or `/members/<ownerSlug>/<slug>` while it
 *    holds no handle yet. `ownerSlug` is the CREATOR's profile slug, whoever
 *    is viewing and whoever else co-owns the persona.
 *  - UNLINKED -> `/p/<handle>`.
 *
 * `ownerSlug` and `ownerName` are therefore populated for LINKED personas ONLY
 * and are `null` for every unlinked one, by the card's own rule (`toCardDTO`):
 * a pseudonymous persona never discloses who is behind it, and a list of what
 * one member follows is exactly the surface where a leak would be cheap to
 * harvest. An unlinked persona's owner is never even looked up.
 *
 * Either field can be `null` on a persona whose address cannot be resolved (a
 * linked persona whose creator profile row has gone). The client renders that
 * row without a link rather than fabricating one, because a fabricated
 * `/p/<slug>` is a dead link a member only discovers weeks later.
 *
 * `viewerFollowing` is computed by the card's own batched lookup, so it is
 * `true` on every row unless the member unfollowed between the page query and
 * the decoration, in which case the row says so truthfully.
 */
export interface FollowedPersonaView extends Omit<
  SubprofileCardView,
  'handle'
> {
  /** The persona's global handle, its `/p/<handle>` address, for both link
   *  kinds. `null` while a persona holds none (a draft, or a linked row the
   *  handle backfill has not reached), and the client falls back to the
   *  nested address. The card ships `''` here; this list has always shipped
   *  `null`, and the Studio's followed-artists list reads it that way. */
  handle: string | null;
  /** When THIS viewer started following, newest first in the list. */
  followedAt: Date;
}

/**
 * One page of `GET /subprofiles/following`.
 *
 * `total` is the viewer's full visible count, whichever way the page was
 * chosen. `nextCursor` is the `before` value for the page after this one, or
 * `null` when nothing follows it. A client that unfollows in place should page
 * with the cursor: it names a position in the list, so removing a row above it
 * shifts nothing. An offset `page` moves by one row per unfollow and skips the
 * persona that slid up into the gap. Under a cursor, `page` echoes the
 * request's own `page`
 * (normally absent, so 1) and carries no position.
 */
export interface FollowedPersonaPage extends Paginated<FollowedPersonaView> {
  nextCursor: string | null;
}
