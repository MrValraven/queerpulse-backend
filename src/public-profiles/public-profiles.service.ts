import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { SocialLink } from '../profiles/entities/social-link.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import {
  PublicProfileResponse,
  toPublicProfile,
} from './public-profile-response';

/**
 * The ONE message every rejection uses. "No such slug", "exists but not
 * published", "deactivated" and "visibility is not open" MUST be
 * indistinguishable: a distinct status or wording for any of them turns this
 * endpoint into an oracle that confirms a member exists, which is precisely the
 * fact an un-published member is trying not to disclose. See the controller for
 * why this is 404 and never 403.
 */
const NOT_FOUND_MESSAGE = 'Profile not found';

@Injectable()
export class PublicProfilesService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
  ) {}

  /**
   * Resolve a published profile for an anonymous caller.
   *
   * ---------------------------------------------------------------------------
   * THE GATE — all three conditions, expressed as inner joins in one query
   * ---------------------------------------------------------------------------
   * 1. `member_preferences.public_profile_enabled = true`. This is the switch
   *    the member actually flipped, and this endpoint is the thing that finally
   *    makes it mean something (it was inert until now — see the column doc).
   *    Modelled as an INNER JOIN so the "member never opened the settings page,
   *    so there is no row" case falls through to not-found. That is the correct
   *    reading: `DEFAULT_PUBLIC_PROFILE_ENABLED` is `false`, and a publication
   *    switch must fail closed on a missing row, never open.
   *
   * 2. `users.status = 'active'`. Deactivation (an explicit "pause my account")
   *    and the 30-day erasure grace period both set `deactivated` — see
   *    `AddDeactivatedStatus1782800710000`, whose entire premise is that the
   *    codebase's existing `status = 'active'` predicates are what make hiding
   *    real. This is one of those predicates, so a member who deactivates or
   *    requests deletion vanishes from the open web on their next request, with
   *    no extra bookkeeping and nothing to remember to wire up. `suspended` is
   *    excluded by the same clause, which is also what we want: a suspended
   *    member should not keep a published page.
   *
   * 3. `profiles.visibility = 'open'`.
   *
   * ---------------------------------------------------------------------------
   * VISIBILITY COMPOSITION RULE: the public flag INTERSECTS visibility, never
   * overrides it. An anonymous viewer must never see more than the least
   * privileged signed-in member sees.
   * ---------------------------------------------------------------------------
   * `ProfilesService.canViewFull` grants the full profile to the owner, to
   * everyone when `visibility = open`, and to accepted connections when
   * `visibility = network`; `private` gives everyone but the owner the limited
   * card. An anonymous caller is not the owner and can never be a connection,
   * so under those same rules they are the LEAST privileged viewer possible.
   * Therefore only `open` can be published: for `network` and `private` the
   * member has said the detail is contingent on a relationship the open web
   * cannot have, and `public_profile_enabled` is not a licence to dissolve that
   * condition. Turning the flag on while set to `network`/`private` is a
   * contradictory pair of settings, and the safe resolution of a contradiction
   * about disclosure is the narrower one.
   *
   * The tempting alternative — serve the LIMITED card for `network`/`private`,
   * mirroring what a non-connected member gets — is rejected on two grounds.
   * It would still publish a real profile (name, avatar, tagline) to the open
   * web from a setting that means "not by default"; and `LimitedProfileResponse`
   * carries `vouchCount` and `verified` via `ProfileCard`, both of which are on
   * this endpoint's forbidden list, so it is not a shape that could be published
   * as-is anyway. Not-found is the honest answer.
   */
  async getBySlug(slug: string): Promise<PublicProfileResponse> {
    // One query, all three gates. Written as joins rather than as fetch-then-
    // check-in-JS so there is no intermediate state in which a profile row that
    // fails a gate is sitting in a variable next to a response mapper, and no
    // early-return path that a later edit could make leak a different error.
    const profile = await this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .innerJoin(
        MemberPreferences,
        'mp',
        'mp.user_id = p.user_id AND mp.public_profile_enabled = true',
      )
      .where('p.slug = :slug', { slug })
      .andWhere('p.visibility = :open', { open: ProfileVisibility.Open })
      .getOne();

    if (!profile) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }

    // Only reached once the profile is confirmed published, so an un-published
    // member's socials/work are never even read out of the database.
    const [socials, work] = await Promise.all([
      this.socialLinks.find({
        where: { userId: profile.userId },
        order: { position: 'ASC' },
      }),
      this.workItems.find({
        where: { userId: profile.userId },
        order: { position: 'ASC' },
      }),
    ]);

    return toPublicProfile(profile, socials, work);
  }
}
