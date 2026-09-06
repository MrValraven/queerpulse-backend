import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { toImageUrl } from './image-url';

/** Compact, cross-domain-safe view of a member, embedded wherever another
 * domain needs to display "who" (an event host, a vouch's voucher, a
 * connection's counterpart) without exposing the full profile. */
export interface MemberRef {
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  avatarUrl: string | null;
}

/** The two columns the photo gate reads. Structural rather than the whole
 * `Profile` so a mapper holding a partially selected row can pass it straight
 * in without widening its query. */
export interface AvatarPhotoGateSource {
  avatarUrl: string | null;
  photoVisible: boolean;
}

/**
 * THE one spelling of the `photoVisible` gate for every cross-domain surface
 * that renders a member's face: feed and forum actors (through `toMemberRef`
 * below), DM author summaries, event attendees, organisers and lineup entries,
 * connection cards and their introducer, and the membership-card issuer
 * roster. Returns `null` the moment the member has turned "Show your photo"
 * off, so a hidden face cannot come back through a mapper that reached for
 * `toImageUrl(profile.avatarUrl)` and forgot the branch. Five mappers had.
 *
 * There is deliberately no owner-self exception, matching `toMemberRef`: these
 * shapes carry no viewer identity to derive one from. The owner-aware variant
 * is `gateAvatarUrl` in `profiles/profile-response.ts`, used only where the
 * viewer is known and the card's subject may be the viewer themselves.
 */
export function toVisibleAvatarUrl(
  profile: AvatarPhotoGateSource | null | undefined,
): string | null {
  if (!profile) return null;
  return profile.photoVisible ? toImageUrl(profile.avatarUrl) : null;
}

/**
 * Maps a `Profile` row to a `MemberRef`, or `null` when there isn't one
 * (e.g. an optional join came back empty) — lets callers `?? null` through
 * without a separate null check.
 *
 * `avatarUrl` honours the member's `photoVisible` toggle: it is `null` once
 * the member has turned their photo off, mirroring `gateAvatarUrl` in
 * `profiles/profile-response.ts` so the member's face can't render next to a
 * feed post or as an event host after they hid it. This is the single choke
 * point every cross-domain `MemberRef` flows through (feed authors, event
 * hosts, `new_member` actors), so the gate lives here rather than at each
 * caller — as `toVisibleAvatarUrl` above, which the mappers that take a raw
 * `Profile` instead of a `MemberRef` call directly. There is deliberately no
 * owner-self exception: these compact refs
 * carry no viewer identity, so a hidden photo is hidden even from its own
 * member on these surfaces (the owner still sees it on their full profile,
 * which uses the `isOwner`-aware `gateAvatarUrl`).
 */
export function toMemberRef(
  profile: Profile | undefined | null,
): MemberRef | null {
  if (!profile) return null;
  return {
    slug: profile.slug,
    firstName: profile.firstName,
    lastName: profile.lastName,
    pronouns: profile.pronouns,
    avatarUrl: toVisibleAvatarUrl(profile),
  };
}

/**
 * Batches the profile lookups every domain needs to resolve `userId`s and
 * `slug`s to/from display-ready `MemberRef`s, without each domain pulling in
 * `ProfilesService` directly.
 *
 * This is a plain class, not an `@Injectable()` — construct it with the
 * caller's own injected `Repository<Profile>` (`new MemberLookup(this.profiles)`)
 * so any service that already holds a profiles repo can use it directly.
 */
export class MemberLookup {
  constructor(private readonly profiles: Repository<Profile>) {}

  /** userId -> MemberRef, for every id that has a profile. */
  async byUserIds(userIds: string[]): Promise<Map<string, MemberRef>> {
    const map = new Map<string, MemberRef>();
    if (!userIds.length) return map;

    const rows = await this.profiles.find({ where: { userId: In(userIds) } });
    for (const row of rows) {
      const ref = toMemberRef(row);
      if (ref) map.set(row.userId, ref);
    }
    return map;
  }

  /**
   * slug -> userId, restricted to profiles of active users (mirrors
   * `ProfilesService.searchMembers`'s `u.status = :active` join).
   */
  async userIdsForSlugs(slugs: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!slugs.length) return map;

    const rows = await this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.slug IN (:...slugs)', { slugs })
      .getMany();

    for (const row of rows) {
      map.set(row.slug, row.userId);
    }
    return map;
  }

  /** Single-slug convenience built on `userIdsForSlugs`. */
  async userIdForSlug(slug: string): Promise<string | null> {
    const map = await this.userIdsForSlugs([slug]);
    return map.get(slug) ?? null;
  }
}
