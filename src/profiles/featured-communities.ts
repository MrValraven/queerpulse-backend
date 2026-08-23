import { CommunityType } from '../communities/entities/community.entity';
import { RosterRole } from '../communities/entities/community-member.entity';

/**
 * How many communities a member may pin to their profile. Mirrors the frontend
 * picker's `MAX_FEATURED` (CommunitiesPickerSection) — the DTO caps the array so
 * the server is the source of truth, not the client's disabled "Feature" button.
 */
export const MAX_FEATURED_COMMUNITIES = 6;

/**
 * One resolved featured-community pin, as the profile "Communities" section
 * renders it. Everything but `slug` is derived live from the community + the
 * member's current roster row, so the shape stays truthful over time. Matches
 * the frontend's `FeaturedCommunityRefDTO`.
 */
export interface FeaturedCommunityRefView {
  slug: string;
  name: string;
  tagline: string;
  type: CommunityType;
  /** Short human label for the type — matches the frontend's `TYPE_SHORT`. */
  typeLabel: string;
  /** e.g. `"128 members"` — the community's live roster size. */
  countLabel: string;
  role: RosterRole;
  /** Curated ids from COMMUNITY_TAGS; empty when the owner set none. Carried
   *  here for the same reason the discover card DTO carries them: a profile
   *  pin renders the same card and must show its tags without a second fetch. */
  tags: string[];
  /** Resolved (`toImageUrl`) cover-image URL, or null when the community has
   *  no cover — the card letterhead's ground. */
  coverImageUrl: string | null;
  /** The community's denormalised weekly activity count
   *  (`communities.active_this_week`), as the discover card shows it. */
  activeThisWeek: number;
}

/**
 * Short display label for a community type — the capitalized enum value, which
 * is exactly what the frontend's `TYPE_SHORT` map produces
 * (social → "Social", arts → "Arts", …). Kept here so the backend is the source
 * of truth for the label a featured pin renders in live mode.
 */
export function communityTypeLabel(type: CommunityType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
