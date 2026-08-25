// Shared contract for "where is this uploaded image referenced?" — the single
// source of truth consumed by both the my-media (self-scoped) and admin-media
// (cross-user) surfaces via `MediaReferenceResolver`. The backend deliberately
// never returns human-readable prose: `label`/`slug` are raw entity fields and
// the frontend owns all localisation + routing.
export type MediaReferenceType =
  | 'profile-photo' // Profile.avatarUrl
  | 'showcase' // WorkItem.imageUrl
  | 'story-cover' // MagazineIssue.coverUrl
  | 'event-photo' // EventPhoto.storageKey
  | 'event-cover' // Event.coverImageUrl
  | 'group-avatar' // Conversation.avatarUrl
  | 'listing' // Listing.photoGallery[].image
  | 'listing-review' // ListingReview.photo
  | 'persona-avatar' // Subprofile.avatarUrl
  | 'persona-cover' // Subprofile.coverUrl
  | 'persona-item' // SubprofileItem.imageUrl
  | 'community-post' // CommunityPost.image
  | 'community-cover' // Community.coverImageUrl
  | 'community-avatar' // Community.avatarImageUrl
  | 'card-crest' // CommunityCard.crestMediaKey
  | 'card-background' // CommunityCard.backgroundMediaKey
  | 'cinema-cover' // CinemaTitle.coverImageUrl
  | 'landlord' // Landlord.photo
  | 'company-work' // Company.work[].imageUrl
  | 'housing' // HousingListing.gallery[]
  | 'magazine-author' // MagazineAuthor.avatarUrl
  | 'changemaker' // Changemaker.imageUrl
  | 'collection' // Collection.cover
  | 'magazine-article' // MagazineArticle.blocks[].src / .socialImage
  | 'magazine-deck' // MagazineDeck.cover / .slides[] image refs
  | 'message-photo'; // Message.attachment (a photo sent in a conversation)

export interface MediaReference {
  type: MediaReferenceType;
  /** UUID of the referencing row (the parent persona for a persona-item, the
   *  conversation for a message-photo). */
  entityId: string;
  /** Human title of the item, e.g. "Décima Casa". May be '' if the row has none. */
  label: string;
  /** Slug where the entity has one, for building the frontend link. */
  slug?: string;
}
