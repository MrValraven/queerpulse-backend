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
