import { Profile } from '../users/entities/profile.entity';
import { SocialLink } from '../profiles/entities/social-link.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';

export interface PublicSocialLinkView {
  platform: string;
  urlOrHandle: string;
}

export interface PublicWorkView {
  category: string;
  title: string;
  year: string;
  imageUrl: string | null;
}

/**
 * The ONLY member data this backend serves to an unauthenticated caller.
 *
 * 🔴 This interface is a published surface, not an internal DTO. Everything on
 * it is readable by anyone on the open web — scrapers, search-engine crawlers,
 * an ex, an employer — with no account, no invite and no audit trail. Treat any
 * addition here as a product decision about publishing to the world, not as a
 * field mapping.
 *
 * The maintainer's decided set is: display name, pronouns, tagline, avatar,
 * bio, links/socials, and public work/portfolio. Nothing else.
 */
export interface PublicProfileResponse {
  slug: string;
  displayName: string;
  pronouns: string | null;
  tagline: string | null;
  avatarUrl: string | null;
  bio: string | null;
  socials: PublicSocialLinkView[];
  work: PublicWorkView[];
}

/**
 * Explicit ALLOWLIST projection — deliberately not `{ ...profile }` minus an
 * omit list, and deliberately not built on `toProfileCard`/`toFullProfile`.
 *
 * The difference matters on the day someone adds a column to `profiles`. With a
 * spread-minus-omit, a new column is published to the open web the moment it
 * merges, and the only thing standing between a member and that disclosure is
 * whether the author of an unrelated migration remembered this file exists.
 * With a named-field allowlist, a new column is invisible here until someone
 * writes its name in, which is exactly the review conversation that should
 * happen. The same reasoning is why this does not reuse the member-facing
 * mappers in `src/profiles/profile-response.ts`: those are shaped for an
 * authenticated audience and grow fields (they already carry `identities`,
 * `lookingFor`, `openTo`, `vouchCount`, `location`, `visibility`) that must
 * never cross this boundary.
 *
 * Fields consciously NOT published, each verified against the entities:
 *   - `users.email`                         — contact data, never public.
 *   - `profiles.identities`                 — special-category data (owner-only).
 *   - `profiles.discoverableIdentities`     — opt-in for the MEMBER directory
 *                                             only; publishing it here would
 *                                             re-scope a consent that was given
 *                                             for a signed-in audience.
 *   - `profiles.lookingFor`, `openTo`       — private/relational intent.
 *   - anything from `member_preferences`    — `outAtWork` and `transSupport` are
 *                                             outness disclosures; the flag
 *                                             itself is a gate, not a field.
 *   - vouch counts, connections, groups     — social graph.
 *   - `profiles.location`, `now`, `tags`    — not in the decided set; `location`
 *                                             in particular is safety-sensitive.
 *   - `verified`, `joinedAt`, `visibility`  — account/moderation state.
 *   - `board`, `skills`, `shapings`,
 *     `activity`, `related`                 — not in the decided set.
 */
export function toPublicProfile(
  profile: Profile,
  socials: SocialLink[],
  work: WorkItem[],
): PublicProfileResponse {
  return {
    slug: profile.slug,
    // A single display name rather than first/last as separate fields: the
    // public page renders one name, and splitting it invites callers to build
    // "lastname" indexes off an endpoint meant to show a person, not a record.
    //
    // PUBLISHING THE SURNAME IS A DELIBERATE DECISION, not an artefact of the
    // entity having `firstName`/`lastName`. It was raised and kept: this page
    // is opt-in AND requires `visibility = open`, and a public figure being
    // findable by their full name is the point of opting in. Understand the
    // cost before changing it in either direction — a surname on an
    // anonymously-readable, search-indexable page is what makes someone
    // findable by an employer, a landlord, or family, and once crawlers have
    // it, un-publishing does not un-index it.
    displayName: `${profile.firstName} ${profile.lastName}`.trim(),
    pronouns: profile.pronouns,
    tagline: profile.tagline,
    avatarUrl: profile.avatarUrl,
    bio: profile.bio,
    socials: socials.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
    })),
    work: work.map((w) => ({
      category: w.category,
      title: w.title,
      year: w.year,
      imageUrl: w.imageUrl,
    })),
  };
}
