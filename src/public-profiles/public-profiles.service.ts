import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HandlesService } from '../handles/handles.service';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { Activity } from '../profiles/entities/activity.entity';
import { ActivityVisibilityService } from '../profiles/activity-visibility.service';
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
  // A member is taken down under the `member` subject type, keyed by slug or
  // userId (see `Report.subjectId`) — the gate below checks both.
  private static readonly MEMBER_SUBJECT_TYPE = 'member';

  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
    private readonly activityVisibility: ActivityVisibilityService,
    private readonly contentModeration: ContentModerationService,
    // Read-only here, and only for `previousProfileOwnerOf` (PRD-204). The
    // module's isolation note is about not reaching the authenticated PROFILE
    // read path; the handle registry is a different thing, a namespace ledger
    // that already decides who owns a username. Resolving a renamed-away-from
    // username against a second, local spelling of that rule is how the two
    // answers drift apart, and a drifted answer here forwards a stranger's
    // traffic to the wrong member. Nothing in this file writes to the registry.
    private readonly handles: HandlesService,
  ) {}

  // The public page shows the same short "Recent activity" window the
  // member-facing profile does. Only reached after the publish + takedown
  // gates, and every row is already write-filtered to public-visible actions.
  private static readonly ACTIVITY_LIMIT = 6;

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
    // PRD-204: a slug with no published profile may be a username this member
    // renamed away from and still holds the reclaim reservation for.
    // `throwMovedOrNotFound` always throws, so the `??` branch never yields.
    const profile =
      (await this.publishedProfileQuery()
        .andWhere('p.slug = :slug', { slug })
        .getOne()) ?? (await this.throwMovedOrNotFound(slug));

    // Moderator takedown gate. An anonymous caller is never the owner and never
    // staff, so a `hide_content`/`remove_content` on this member is absolute
    // here — the open web must not serve a hidden/removed member. The SAME
    // not-found answer as every other gate above, for the same reason: the
    // rejection must not distinguish "taken down" from "never existed". Checked
    // by slug OR userId, matching how a member is addressed in a report.
    if (await this.isTakenDown([profile.slug, profile.userId])) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }

    // Only reached once the profile is confirmed published, so an un-published
    // member's socials/work/activity are never even read out of the database.
    const [socials, work, activity] = await Promise.all([
      this.socialLinks.find({
        where: { userId: profile.userId },
        order: { position: 'ASC' },
      }),
      this.workItems.find({
        where: { userId: profile.userId },
        order: { position: 'ASC' },
      }),
      this.activities.find({
        where: { userId: profile.userId },
        order: { occurredAt: 'DESC' },
        take: PublicProfilesService.ACTIVITY_LIMIT,
      }),
    ]);

    // Re-check every row against its subject's CURRENT visibility before it
    // reaches the open web. The write-time gate only knew what was public at
    // the instant of the action, and this is the one surface that serves a
    // logged-out visitor. `filterVisible` also purges what it rejects, so the
    // row stops being served to every audience, not just this one.
    const visibleActivity =
      await this.activityVisibility.filterVisible(activity);

    return toPublicProfile(profile, socials, work, visibleActivity);
  }

  /**
   * THE GATE, as a builder, so every path that resolves a profile for the open
   * web goes through the same three conditions. Read the long note on
   * `getBySlug` for why each one is here.
   *
   * Factored out for the moved-username path below, which has to answer the
   * same question about a DIFFERENT member (the one who used to hold the
   * requested name) and must not answer it more loosely. Written as joins
   * rather than as fetch-then-check-in-JS for the reason that has always
   * applied: there is then no intermediate state in which a profile row that
   * fails a gate is sitting in a variable next to a response mapper.
   *
   * The builder already holds the `where`, so callers add `andWhere`. A second
   * `where` would RESET the clause and drop the visibility gate with it.
   */
  private publishedProfileQuery(): SelectQueryBuilder<Profile> {
    return this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .innerJoin(
        MemberPreferences,
        'mp',
        'mp.user_id = p.user_id AND mp.public_profile_enabled = true',
      )
      .where('p.visibility = :open', { open: ProfileVisibility.Open });
  }

  /**
   * Whether a moderator takedown stands against any of these subject ids. A
   * member is addressed in a report by slug OR userId, so both are passed.
   */
  private async isTakenDown(subjectIds: string[]): Promise<boolean> {
    const moderationStates = await this.contentModeration.statesForAnyType(
      [PublicProfilesService.MEMBER_SUBJECT_TYPE],
      subjectIds,
    );
    return subjectIds.some((subjectId) => {
      const state = moderationStates.get(subjectId);
      return !!state && (state.hidden || state.removed);
    });
  }

  /**
   * PRD-204, the anonymous half. This is the address a member prints on a card,
   * puts in a bio, or hands to someone off the platform, so it is the link most
   * likely to be old and least likely to be re-shared. Until now a rename broke
   * every one of them, and the person who hit the wall was a stranger with no
   * account and no way to search for anybody.
   *
   * The forwarding is bounded by the same window that protects the name:
   * `previousProfileOwnerOf` answers only while the reclaim cooldown is running
   * and nobody holds the name in the live registry. Once it lapses, or somebody
   * else claims the name, this stops answering, so a new owner can never
   * inherit traffic meant for the previous one. Nothing is cached, here or in
   * the response: the controller sets `Cache-Control: no-store` before the
   * lookup, so it lands on this 404 too.
   *
   * ---------------------------------------------------------------------------
   * WHY THE GATE RUNS AGAIN, ON THE OTHER MEMBER
   * ---------------------------------------------------------------------------
   * The caller is anonymous and a public profile is opt-in, so "that username
   * moved" is a disclosure in its own right: it says an account still exists.
   * A member who renamed AND turned their public page off has said no twice,
   * and must be indistinguishable from a name nobody ever held. So the previous
   * owner's CURRENT profile is resolved through `publishedProfileQuery` (the
   * publication switch, `users.status = active`, `visibility = open`) and then
   * through the takedown gate, exactly as a first-hand visit would be, before
   * anything is emitted. Only a member whose page a stranger could already open
   * at its new address can forward to it, which is why the payload discloses
   * nothing that address does not.
   *
   * The old slug is checked for a takedown too, alongside the current one: a
   * report filed against the name the member used to hold still names them.
   *
   * The payload is an application-level 404 rather than an HTTP 301/308, and
   * the shape matches `ProfilesService.throwMovedOrNotFound` so the SPA branch
   * stays one function. A 301/308 is permanently cacheable, and this forwarding
   * MUST expire with the reclaim cooldown; and `fetch` follows a redirect
   * transparently, so the app would render the profile under the dead URL and
   * never correct the address bar.
   *
   * Never returns. The caller treats it as a throw.
   */
  private async throwMovedOrNotFound(slug: string): Promise<never> {
    const previousOwnerUserId = await this.handles.previousProfileOwnerOf(slug);
    if (!previousOwnerUserId) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    const moved = await this.publishedProfileQuery()
      .andWhere('p.user_id = :previousOwnerUserId', { previousOwnerUserId })
      .getOne();
    if (!moved) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    if (await this.isTakenDown([slug, moved.slug, moved.userId])) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    throw new NotFoundException({
      code: 'PROFILE_MOVED',
      message: 'That username has moved',
      slug: moved.slug,
    });
  }
}
