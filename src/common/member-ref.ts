import { FindManyOptions, In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
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
  /**
   * Present (and `true`) only on the stand-in `MemberLookup.byUserIds` hands
   * back for a member whose account is paused, suspended or inside the
   * 30-day deletion grace. The stand-in carries no name, slug or photo, so
   * the client renders its "[deactivated member]" label from this flag and
   * links nowhere. Absent on every ordinary ref.
   */
  isInactiveMember?: true;
}

/**
 * What `MemberLookup.byUserIds` does with a member whose account is not
 * `active` (paused, suspended, or inside the deletion grace):
 *
 *  - `placeholder` (the default): the id maps to `inactiveMemberRef()`, so a
 *    byline on a post or reply that stays up keeps rendering, as
 *    "[deactivated member]", with nothing that identifies the person.
 *  - `drop`: the id is left out of the map, for lists of people (rosters,
 *    member pickers) where an entry with no name is noise.
 *  - `include`: the real ref, for staff tooling that must see who an account
 *    belongs to (moderation queues, admin member records, DSAR handling) and
 *    for a member's own private safety lists.
 */
export type InactiveMemberHandling = 'placeholder' | 'drop' | 'include';

export interface MemberLookupOptions {
  inactive?: InactiveMemberHandling;
}

/**
 * The anonymous stand-in for a member whose account is not active. A fresh
 * object per call, so a caller that decorates a ref in place cannot leak the
 * decoration into another row. The empty `slug` is deliberate: there is no
 * profile to link to while the account is paused, and the real slug would
 * identify the member to anyone who opened it later.
 */
export function inactiveMemberRef(): MemberRef {
  return {
    slug: '',
    firstName: '',
    lastName: '',
    pronouns: null,
    avatarUrl: null,
    isInactiveMember: true,
  };
}

/**
 * Whether a profile row loaded WITH its `user` relation belongs to an account
 * that is paused, suspended or in the deletion grace.
 *
 * How the read fills `user` (checked against TypeORM 0.3.30,
 * `SelectQueryBuilder.buildRelations`): `relations: { user: true }` with an
 * object under `select.user` adds a LEFT JOIN on the relation marked
 * `select: true` and passes `{ id, status }` to `buildSelect` for the join
 * alias, so `profile.user` is hydrated with exactly `id` and `status`.
 *
 * Two missing cases, decided on purpose:
 *  - `user` itself absent reads as ACTIVE. In production that case does not
 *    occur: `profiles.user_id` is the primary key and a non-null foreign key
 *    to `users`, so the join always finds the row. The branch exists for
 *    repository stand-ins in specs that return bare profile rows.
 *  - `user` present with no `status` reads as INACTIVE. That would mean the
 *    select lost the column, and a lost column must fail toward hiding the
 *    member, so it is never silently treated as active.
 */
function isInactiveAccount(profile: Profile): boolean {
  const owner: User | undefined = profile.user;
  if (!owner) return false;
  return owner.status !== UserStatus.Active;
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

  /**
   * The exact `find` options `byUserIds` reads with: the profile columns
   * `toMemberRef` maps, plus only `id` and `status` from the `user` relation,
   * so no other account column (email, role, flags) is ever loaded for a
   * byline. Exported so a spec asserting the read can name it.
   */
  static findOptionsFor(userIds: string[]): FindManyOptions<Profile> {
    return {
      where: { userId: In(userIds) },
      relations: { user: true },
      select: {
        userId: true,
        slug: true,
        firstName: true,
        lastName: true,
        pronouns: true,
        avatarUrl: true,
        photoVisible: true,
        user: { id: true, status: true },
      },
    };
  }

  /**
   * userId -> MemberRef, for every id that has a profile.
   *
   * PRD-507. A member who paused their account, or asked for it to be
   * deleted, was promised "Your name is removed from member lists" and
   * "attributed to [deactivated member]". This is the one place every
   * cross-domain byline is resolved, so the promise is kept here: by default
   * an inactive account maps to `inactiveMemberRef()`. See
   * `InactiveMemberHandling` for the two other answers a caller can ask for.
   */
  async byUserIds(
    userIds: string[],
    options: MemberLookupOptions = {},
  ): Promise<Map<string, MemberRef>> {
    const map = new Map<string, MemberRef>();
    if (!userIds.length) return map;
    const inactiveHandling = options.inactive ?? 'placeholder';

    const rows = await this.profiles.find(MemberLookup.findOptionsFor(userIds));
    for (const row of rows) {
      if (isInactiveAccount(row) && inactiveHandling !== 'include') {
        if (inactiveHandling === 'placeholder') {
          map.set(row.userId, inactiveMemberRef());
        }
        continue;
      }
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
