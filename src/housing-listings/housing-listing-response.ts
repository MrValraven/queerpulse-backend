import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import {
  HousingListing,
  HousingListingStatus,
  HousingListingType,
} from './entities/housing-listing.entity';

/**
 * Wire shape for a housing listing. Used for both the owner view and the
 * public browse — it exposes no contact/moderation-sensitive columns beyond
 * `status`, and `lister` is the same compact `MemberRef` every other domain
 * embeds. `gallery` is resolved to displayable URLs (empty slots dropped).
 */
export interface HousingListingDTO {
  ref: string;
  slug: string;
  status: HousingListingStatus;
  lister: MemberRef | null;
  createdAt: string;

  type: HousingListingType;
  title: string;
  blurb: string;
  city: string;
  area: string;
  rentEuros: number;
  billsIncluded: boolean;
  lgbtqFriendly: boolean;
  availableFrom: string | null;
  minStayMonths: number | null;
  description: string;
  features: string[];
  idealFor: string[];
  gallery: string[];
}

export function toHousingListingDTO(
  listing: HousingListing,
  lister: MemberRef | null,
): HousingListingDTO {
  return {
    ref: listing.ref,
    slug: listing.slug,
    status: listing.status,
    lister,
    createdAt: listing.createdAt.toISOString(),

    type: listing.type,
    title: listing.title,
    blurb: listing.blurb,
    city: listing.city,
    area: listing.area,
    rentEuros: listing.rentEuros,
    billsIncluded: listing.billsIncluded,
    lgbtqFriendly: listing.lgbtqFriendly,
    availableFrom: listing.availableFrom,
    minStayMonths: listing.minStayMonths,
    description: listing.description,
    features: listing.features,
    idealFor: listing.idealFor,
    // toImageUrl('') -> null; drop empty/unset slots so the client renders a
    // clean gallery.
    gallery: listing.gallery
      .map((ref) => toImageUrl(ref))
      .filter((url): url is string => url !== null),
  };
}
