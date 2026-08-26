import { In, Repository } from 'typeorm';
import { MemberRef, toMemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';

/**
 * The lister block a housing listing embeds.
 *
 * `MemberRef` (slug / name / pronouns / avatar) is the cross-domain compact
 * shape every other feature uses, and it was all a housing listing carried. The
 * housing detail page renders more than that: "member since" and a short bio
 * sit next to the enquiry button, because deciding whether to message a
 * stranger about their spare room is exactly the moment a reader wants to know
 * who they are. With nothing on the wire the frontend hardcoded
 * `memberSince: ''` and `bio: ''` for every lister, which is a fabricated
 * profile rendered as if it were real.
 *
 * Both extra fields come from the member's OWN public profile, the same values
 * `/members/:slug` already serves, so nothing is disclosed here that a reader
 * could not reach by clicking through.
 */
export interface HousingListerRef extends MemberRef {
  /** ISO-8601 timestamp the member joined (`profiles.joined_at`), or null when
   * the profile row is gone. The frontend formats it ("Member since 2025"). */
  memberSince: string | null;
  /** The member's own public bio, or null when they wrote none. Plain text. */
  bio: string | null;
}

function toHousingListerRef(profile: Profile): HousingListerRef | null {
  const base = toMemberRef(profile);
  if (!base) return null;
  return {
    ...base,
    memberSince: profile.joinedAt ? profile.joinedAt.toISOString() : null,
    bio: profile.bio ?? null,
  };
}

/**
 * Batched `userId -> HousingListerRef` hydration.
 *
 * A plain class rather than an `@Injectable()`, exactly like `MemberLookup`
 * (`common/member-ref.ts`) which it mirrors: construct it with the caller's own
 * injected `Repository<Profile>`. It issues the same single `find` that
 * `MemberLookup.byUserIds` does, so replacing one with the other costs no extra
 * query.
 */
export class HousingListerLookup {
  constructor(private readonly profiles: Repository<Profile>) {}

  async byUserIds(userIds: string[]): Promise<Map<string, HousingListerRef>> {
    const listersByUserId = new Map<string, HousingListerRef>();
    if (!userIds.length) return listersByUserId;

    const rows = await this.profiles.find({ where: { userId: In(userIds) } });
    for (const row of rows) {
      const lister = toHousingListerRef(row);
      if (lister) listersByUserId.set(row.userId, lister);
    }
    return listersByUserId;
  }
}
