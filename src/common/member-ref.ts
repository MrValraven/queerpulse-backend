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
  avatarUrl: string | null;
}

/**
 * Maps a `Profile` row to a `MemberRef`, or `null` when there isn't one
 * (e.g. an optional join came back empty) — lets callers `?? null` through
 * without a separate null check.
 */
export function toMemberRef(
  profile: Profile | undefined | null,
): MemberRef | null {
  if (!profile) return null;
  return {
    slug: profile.slug,
    firstName: profile.firstName,
    lastName: profile.lastName,
    avatarUrl: toImageUrl(profile.avatarUrl),
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
