import { toImageUrl } from '../../common/image-url';
import {
  Event,
  EventVenueConfirmation,
} from '../../events/entities/event.entity';
import { Profile } from '../../users/entities/profile.entity';

/**
 * Whether the venue's owner has agreed to carry a gathering that named their
 * business (LOC-16). Mirrors `EventVenueConfirmation` as a wire-level string
 * union rather than re-exporting the entity enum, so the response contract
 * does not move whenever the storage does.
 */
export type VenueEventAttachmentState = 'pending' | 'confirmed';

/**
 * One gathering attached to a business listing, as its OWNER sees it.
 *
 * WHAT THIS DISCLOSES, and why each field is safe to disclose here. Every one
 * of these is already public on the gathering's own page, and this endpoint
 * only ever carries gatherings scoped `public` or `members`, the tiers that
 * can actually reach the venue's page. A gathering scoped `invite_only`,
 * `network`, `extended_network` or `community` never appears here at all: it
 * cannot show on the venue's page, so there is nothing for its owner to
 * consent to, and listing it would disclose a private gathering to somebody
 * outside its audience.
 *
 * THE HOST IS NAMED, unlike every other item in the owner's pending inbox
 * (`owner-listing-pending.dto.ts` withholds the suggester, the claimant and
 * the reporter). The difference is that those three are adversarial acts filed
 * privately about the owner, while this is a member publicly organising an
 * event and putting the venue's name on it. Their name is on the gathering's
 * own page already, and an owner deciding whether to host somebody has to know
 * who they are deciding about.
 */
export interface VenueEventAttachmentDTO {
  /** The gathering's uuid, the path segment for confirm/detach. */
  eventId: string;
  /** Its public slug, for the deep link to the gathering itself. */
  eventSlug: string;
  title: string;
  /** ISO 8601. */
  startAt: string;
  /** ISO 8601, or null for a gathering with no declared end. */
  endAt: string | null;
  state: VenueEventAttachmentState;
  /** ISO 8601 when the owner confirmed. Null while pending, and also null on
   *  a confirmed attachment that predates venue consent and was grandfathered
   *  by the backfill rather than agreed to by a person. */
  confirmedAt: string | null;
  /** ISO 8601 when the gathering was created, which is when it attached. */
  attachedAt: string;
  /** `public` or `members`: how widely this would show if confirmed. */
  visibility: string;
  /** The organiser, or null when their account has since been erased. */
  host: VenueEventHostRef | null;
}

/** The organiser of a gathering attached to a venue. Same two-field shape the
 *  directory's other member references use, plus a name to read. */
export interface VenueEventHostRef {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

/**
 * `GET /listings/:ref/venue-events` (LOC-16). Every upcoming gathering that
 * names this business as its venue, split by whether the owner has agreed to
 * carry it.
 *
 * `counts` are the true totals and the arrays are capped
 * (`VENUE_EVENT_ITEM_CAP`), the same split `OwnerListingPendingDTO` uses for
 * the same reason: a badge stays honest while the payload stays bounded.
 */
export interface ListingVenueEventsDTO {
  counts: {
    pending: number;
    confirmed: number;
    total: number;
  };
  /** Soonest first, capped. Awaiting the owner's decision. */
  pending: VenueEventAttachmentDTO[];
  /** Soonest first, capped. Already carried on the public page. */
  confirmed: VenueEventAttachmentDTO[];
}

/**
 * `DELETE /listings/:ref/venue-events/:eventId` (LOC-16). What the owner gets
 * back after detaching.
 *
 * `venue` is the free-text venue string the gathering fell back to. Detaching
 * unlinks the venue; it never deletes the gathering, and it never blanks where
 * the gathering says it is happening. If the host had left the free-text
 * field empty, the business's name is copied into it on the way out, so the
 * gathering keeps a readable location instead of losing one.
 */
export interface DetachedVenueEventDTO {
  eventId: string;
  eventSlug: string;
  /** Always `'detached'`. Present so the frontend can switch on one field
   *  across all three of this endpoint family's responses. */
  state: 'detached';
  /** ISO 8601. */
  detachedAt: string;
  /** The gathering's free-text venue after the detach. */
  venue: string | null;
}

export function toVenueEventAttachmentDTO(
  event: Event,
  host: Profile | undefined,
): VenueEventAttachmentDTO {
  return {
    eventId: event.id,
    eventSlug: event.slug,
    title: event.title,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt ? event.endAt.toISOString() : null,
    state:
      event.venueConfirmation === EventVenueConfirmation.Confirmed
        ? 'confirmed'
        : 'pending',
    confirmedAt: event.venueConfirmedAt
      ? event.venueConfirmedAt.toISOString()
      : null,
    attachedAt: event.createdAt.toISOString(),
    visibility: event.visibility,
    host: host
      ? {
          slug: host.slug,
          firstName: host.firstName,
          lastName: host.lastName,
          // Honours the member's own "show my photo" switch, the same call
          // `DirectoryService.publicAvatarUrl` makes for every other member
          // reference this domain resolves.
          avatarUrl: host.photoVisible ? toImageUrl(host.avatarUrl) : null,
        }
      : null,
  };
}
