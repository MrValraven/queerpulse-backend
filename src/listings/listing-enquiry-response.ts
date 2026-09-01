/**
 * Wire shapes for contacting a business through QueerPulse. Hand-mapped like
 * every other response in this module (there is no global serializer), and
 * deliberately narrow: neither shape carries the owner's name, slug, avatar,
 * email or phone number.
 *
 * That last point is the feature, not an oversight. The reason this endpoint
 * exists is that every other route to a business on a listing page leaves the
 * platform and costs the member their phone number or their email address. A
 * "contact" response that handed back the owner's identity instead would just
 * move the same disclosure to the other side of the exchange.
 */

/** Why the owner of a listing cannot be written to. */
export type ListingContactUnavailableReason =
  /** Nobody has claimed this entry: it was suggested by another member, or
   *  recommended as a friendly venue, so the account attached to it belongs to
   *  the SUBMITTER and not to the business. Writing to them would deliver a
   *  question about a bar to a stranger who once recommended it. */
  | 'unclaimed'
  /** The listing is parked on a platform/house account, or the owning account
   *  no longer exists or is not active. */
  | 'no_owner_account'
  /** The caller owns this listing. */
  | 'own_listing'
  /** A block in either direction. Deliberately the SAME reason string the
   *  member sees for any other blocked interaction, and never distinguished
   *  from "they blocked you", so this endpoint cannot be used to test whether a
   *  particular person has blocked you. */
  | 'unavailable';

/**
 * Which counted cap the caller is currently sitting behind. Not a counter, and
 * deliberately so.
 *
 * WHY NO NUMBERS. The obvious shape for this field is "2 of 3 used today", and
 * it is the wrong one. A remaining count reads as a budget, and a budget invites
 * a member to spend it: the caps exist because the shape that hurts a small
 * queer venue is a steady trickle of private messages from one account, so a UI
 * that says "1 left" is an instruction to send it. What a member actually needs
 * in order to decide is whether they may write now and, if not, why and for how
 * long. That is what these three fields carry, and nothing more. It also keeps
 * the exact cap constants off the wire, which is one less number to tune around.
 */
export type ListingEnquiryLimitReason =
  /** Already written to THIS business inside the last day. The humane cap: the
   *  business has a message from this member sitting unanswered. */
  | 'wrote_to_this_business_today'
  /** Written to enough DIFFERENT businesses inside the last day. Nothing to do
   *  with this listing, which is why it gets its own reason instead of being
   *  folded into the one above. */
  | 'wrote_across_directory_today';

/** `GET /directory/:slug/contact` — whether the "message the business" button
 *  should be offered at all, and what to say next to it. */
export interface ListingContactDTO {
  canMessageOwner: boolean;
  /** `null` exactly when `canMessageOwner` is true. */
  unavailableReason: ListingContactUnavailableReason | null;
  /**
   * True when the caller and the owner are not accepted connections, so the
   * platform's ordinary messaging rule (`MessagesService.sendMessage`) will
   * refuse every message in the thread AFTER this first enquiry, from either
   * side, until a connection is accepted. Surfaced rather than hidden so the
   * flow can be honest about it up front instead of letting the owner discover
   * it when their reply is rejected.
   */
  replyRequiresConnection: boolean;
  /** The thread this member already has with this listing's owner, when they
   *  have written before, so the UI can offer "open the conversation" instead
   *  of a fresh compose box. */
  existingConversationId: string | null;
  /**
   * True when a counted cap would refuse this member's next enquiry, so the
   * composer can be closed BEFORE they type rather than after they have written
   * a message and pressed send.
   *
   * Separate from `canMessageOwner` on purpose. That field answers "is anybody
   * on the other end of this listing", which is a fact about the business; this
   * one answers "may I write to them right now", which is a fact about the
   * caller and is temporary. Collapsing the two would tell a member a venue is
   * unreachable when the truth is that they wrote to it an hour ago, and it
   * would take away the "open the conversation you already started" link, which
   * is exactly the thing a capped member should be doing instead.
   *
   * A COURTESY, NEVER A GATE. `POST /directory/:slug/enquiries` re-checks every
   * cap and is the only authority. This read can be minutes stale by the time
   * somebody finishes typing, so the send path still refuses on its own and the
   * client must still handle a 429.
   *
   * This is the caller's own activity, answered to the caller: the route is
   * behind `ActiveMemberGuard` and keyed off the session's own user id, so no
   * member learns anything here about another member's messages.
   */
  hasReachedEnquiryLimit: boolean;
  /** Which cap, so the copy can be specific. `null` exactly when
   *  `hasReachedEnquiryLimit` is false. */
  enquiryLimitReason: ListingEnquiryLimitReason | null;
  /**
   * ISO 8601 instant at which the cap named above actually lifts, or `null`
   * when nothing is capped.
   *
   * The windows are ROLLING rather than calendar days, so this is a real
   * computed moment (the oldest counted enquiry falling out of its 24 hours),
   * never "midnight". When more than one cap is biting it is the LATER of them,
   * so the answer is never earlier than the moment the member can genuinely
   * write again. The word "today" in the reason above is the honest plain-English
   * summary; this field is the precise version for a client that wants to say
   * "in about 20 hours".
   */
  enquiryLimitClearsAt: string | null;
}

/** `POST /directory/:slug/enquiries` — where the member's message went. */
export interface ListingEnquirySentDTO {
  /** Deep-link target: the 1:1 thread the enquiry was delivered into. */
  conversationId: string;
  /** This listing's own record of the enquiry (see `ListingEnquiry`). */
  enquiryId: string;
  /** Same meaning as on `ListingContactDTO`, repeated here so a client that
   *  posted without reading `contact` first still learns it. */
  replyRequiresConnection: boolean;
}
