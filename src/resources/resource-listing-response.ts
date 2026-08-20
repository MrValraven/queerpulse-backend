import {
  ResourceListing,
  ResourceListingStatus,
} from './entities/resource-listing.entity';

/** Public shape of `GET /resources/listings` — never exposes `status`,
 *  `createdBy`/`updatedBy`, or timestamps to a member. */
export interface ResourceListingResponseDTO {
  id: string;
  category: string;
  title: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  region: string | null;
}

export function toResourceListingResponse(
  listing: ResourceListing,
): ResourceListingResponseDTO {
  return {
    id: listing.id,
    category: listing.category,
    title: listing.title,
    description: listing.description,
    phone: listing.phone,
    email: listing.email,
    website: listing.website,
    region: listing.region,
  };
}

/** Admin view of a listing — the public shape plus status and audit
 *  timestamps. `createdBy`/`updatedBy` are deliberately NOT exposed (mirrors
 *  `AdminReadingGroupProposalDTO` omitting `decidedBy`) — the CRUD table
 *  shows the content, not which staff member touched it. */
export interface AdminResourceListingDTO {
  id: string;
  category: string;
  title: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  region: string | null;
  status: ResourceListingStatus;
  createdAt: string;
  updatedAt: string;
}

export function toAdminResourceListingDTO(
  listing: ResourceListing,
): AdminResourceListingDTO {
  return {
    id: listing.id,
    category: listing.category,
    title: listing.title,
    description: listing.description,
    phone: listing.phone,
    email: listing.email,
    website: listing.website,
    region: listing.region,
    status: listing.status,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}
