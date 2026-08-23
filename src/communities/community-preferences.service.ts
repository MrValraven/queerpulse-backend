import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CommunityPreferencesResponse } from './community-preferences-response';
import {
  CommunityMember,
  CommunityNotificationLevel,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Backs `GET`/`PATCH /communities/:slug/preferences` and
 * `POST /communities/:slug/welcome-seen` — the member's own dial on one
 * community, plus the once-only welcome stamp that goes with it.
 *
 * The authority model is deliberately narrow: every method resolves the
 * caller's OWN roster row from the session user id and writes only that row.
 * There is no "member" parameter anywhere in this service, so there is no
 * shape in which an owner, a moderator or another member can read or change
 * somebody else's notification level. A member's choice to turn a community
 * down is not community-visible information.
 */
@Injectable()
export class CommunityPreferencesService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
  ) {}

  /** `GET /communities/:slug/preferences`. */
  async getPreferences(
    slug: string,
    userId: string,
  ): Promise<CommunityPreferencesResponse> {
    const { community, membership } = await this.loadOwnMembership(
      slug,
      userId,
    );
    return CommunityPreferencesService.toResponse(community, membership);
  }

  /**
   * `PATCH /communities/:slug/preferences`. Idempotent: setting the level
   * already stored is a plain 200 with the same body.
   */
  async updatePreferences(
    slug: string,
    userId: string,
    notificationLevel: CommunityNotificationLevel,
  ): Promise<CommunityPreferencesResponse> {
    const { community, membership } = await this.loadOwnMembership(
      slug,
      userId,
    );
    if (membership.notificationLevel !== notificationLevel) {
      // Scoped by the roster row's primary key, which was resolved from the
      // session user id, so the WHERE clause cannot address another member.
      await this.members.update({ id: membership.id }, { notificationLevel });
      membership.notificationLevel = notificationLevel;
    }
    return CommunityPreferencesService.toResponse(community, membership);
  }

  /**
   * `POST /communities/:slug/welcome-seen` — stamps `welcome_seen_at` on the
   * caller's own roster row so the owner-authored greeting shows once and then
   * stops.
   *
   * Idempotent and first-stamp-wins: an already-stamped row is left alone
   * rather than re-stamped, so the value keeps meaning "when this member first
   * saw the welcome". Returns the same response shape as the GET, which by
   * then reads `shouldShowWelcome: false`.
   */
  async markWelcomeSeen(
    slug: string,
    userId: string,
  ): Promise<CommunityPreferencesResponse> {
    const { community, membership } = await this.loadOwnMembership(
      slug,
      userId,
    );
    if (membership.welcomeSeenAt == null) {
      const seenAt = new Date();
      await this.members.update(
        { id: membership.id },
        { welcomeSeenAt: seenAt },
      );
      membership.welcomeSeenAt = seenAt;
    }
    return CommunityPreferencesService.toResponse(community, membership);
  }

  /**
   * `POST /communities/:slug/rules-acceptance` — records that this member has
   * read the community's house rules at `acceptedRulesVersion`.
   *
   * `CommunitiesService.join` stamps acceptance for someone arriving, and it
   * short-circuits on an existing roster row, so an EXISTING member had no way
   * to record a re-read after an owner edited the rules. Without this route the
   * prompt could only ever be dismissed client-side, which means it returns on
   * every other device and the platform holds no record that the member saw the
   * new terms.
   *
   * The submitted version must match the community's current one. A stale
   * number means the rules changed again while the member was reading, so
   * accepting it would record consent to text they never saw.
   */
  async acceptRules(
    slug: string,
    userId: string,
    acceptedRulesVersion: number,
  ): Promise<CommunityPreferencesResponse> {
    const { community, membership } = await this.loadOwnMembership(
      slug,
      userId,
    );
    if (acceptedRulesVersion !== community.rulesVersion) {
      throw new BadRequestException({
        code: 'RULES_ACCEPTANCE_REQUIRED',
        message:
          'These house rules changed while you were reading them. Have another look and accept the current version.',
        rulesVersion: community.rulesVersion,
      });
    }
    if (membership.rulesVersionAccepted !== acceptedRulesVersion) {
      const acceptedAt = new Date();
      // Scoped by the roster row's primary key, resolved from the session user
      // id, so the WHERE clause cannot address another member.
      await this.members.update(
        { id: membership.id },
        {
          rulesAcceptedAt: acceptedAt,
          rulesVersionAccepted: acceptedRulesVersion,
        },
      );
      membership.rulesAcceptedAt = acceptedAt;
      membership.rulesVersionAccepted = acceptedRulesVersion;
    }
    return CommunityPreferencesService.toResponse(community, membership);
  }

  /**
   * Resolves the community by slug (404 for unknown or archived, the same
   * "don't leak existence" posture as `CommunityMembershipService
   * .assertMemberBySlug`) and the caller's own roster row (403 for a
   * non-member). Two indexed point lookups, and the second one is the only
   * roster read any method here performs.
   */
  private async loadOwnMembership(
    slug: string,
    userId: string,
  ): Promise<{ community: Community; membership: CommunityMember }> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (!membership) {
      throw new ForbiddenException('Only roster members can do that');
    }
    return { community, membership };
  }

  private static toResponse(
    community: Community,
    membership: CommunityMember,
  ): CommunityPreferencesResponse {
    const welcomeMessage = community.welcomeMessage?.trim()
      ? community.welcomeMessage
      : null;
    return {
      communitySlug: community.slug,
      notificationLevel: membership.notificationLevel,
      welcomeMessage,
      shouldShowWelcome:
        welcomeMessage !== null && membership.welcomeSeenAt == null,
      welcomeSeenAt: membership.welcomeSeenAt,
      rulesVersion: community.rulesVersion,
      rulesAcceptedVersion: membership.rulesVersionAccepted,
      // A community with no rules can never owe a re-read, whatever the
      // version counter says. Everyone else owes one when their accepted
      // version is behind (null included: they joined before acceptance was
      // recorded at all).
      shouldReacceptRules:
        community.rules.length > 0 &&
        (membership.rulesVersionAccepted == null ||
          membership.rulesVersionAccepted < community.rulesVersion),
    };
  }
}
