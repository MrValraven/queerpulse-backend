import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { assertCommunityInteriorReadable } from '../communities/community-read-gate';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HiddenEventCommunity } from './entities/hidden-event-community.entity';
import {
  HiddenEventCommunityResponse,
  toHiddenEventCommunityResponse,
} from './hidden-event-communities-response';

/** The most communities one member can hide from their events browse. */
export const HIDDEN_EVENT_COMMUNITIES_LIMIT = 200;

/**
 * The one 404 every refused hide answers with, whatever the reason, so a
 * private, archived or taken-down community reads exactly like an unknown
 * slug.
 */
function hiddenCommunityNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'HIDDEN_COMMUNITY_NOT_FOUND',
    message: 'No community with that name is visible to you.',
  });
}

/**
 * A member's hidden event communities: the communities whose events stay off
 * their upcoming browse (Highlights, Browse, the calendar). The browse filter
 * itself lives in `EventsService`; this service owns the list.
 *
 * Hiding changes no roster row and tells the community nothing. Every write is
 * idempotent: hiding a hidden community returns the existing row, and showing
 * a community that was never hidden answers `{ hidden: false }` all the same.
 *
 * The cap is checked with a count before the insert, so two concurrent hides
 * at 199 rows can land 201. Harmless: the cap only bounds the size of the
 * browse predicate.
 */
@Injectable()
export class HiddenEventCommunitiesService {
  constructor(
    @InjectRepository(HiddenEventCommunity)
    private readonly hiddenCommunities: Repository<HiddenEventCommunity>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly membership: CommunityMembershipService,
    // Injected directly: `CommunitiesModule` imports `EventsModule`, so
    // reaching `CommunitiesService` from here would close a module cycle.
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * `GET /me/hidden-event-communities`: the member's list, newest first. One
   * batched `tierRefsByIds` names every row. A private community the member
   * has since left stays listed (they knew its name, and dropping it would
   * leave them unable to show its events again).
   */
  async list(viewerId: string): Promise<HiddenEventCommunityResponse[]> {
    const rows = await this.hiddenCommunities.find({
      where: { userId: viewerId },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];
    const refsById = await this.membership.tierRefsByIds(
      rows.map((row) => row.communityId),
    );
    const responses: HiddenEventCommunityResponse[] = [];
    for (const row of rows) {
      const communityRef = refsById.get(row.communityId);
      if (!communityRef) continue;
      responses.push(toHiddenEventCommunityResponse(row, communityRef));
    }
    return responses;
  }

  /**
   * `POST /me/hidden-event-communities`. Answers the same 404 body whenever
   * the community's own page would 404 for this viewer, so the route cannot
   * probe a slug the viewer may not see: an unknown slug, a private community
   * the viewer holds no effective role in, and the takedown, archive and
   * parent closures `CommunitiesService.getBySlug` applies (shared through
   * `assertCommunityInteriorReadable`). A roster member still hides an
   * archived community, and community staff still hide a taken-down one,
   * because both still see it and its events.
   */
  async hide(
    viewerId: string,
    communitySlug: string,
  ): Promise<HiddenEventCommunityResponse> {
    const community = await this.communities.findOne({
      where: { slug: communitySlug },
      select: {
        id: true,
        parentId: true,
        slug: true,
        name: true,
        accessTier: true,
        avatarImageUrl: true,
        archivedAt: true,
      },
    });
    if (!community) throw hiddenCommunityNotFound();
    const viewerRole = await this.membership.effectiveRole(community, viewerId);
    if (community.accessTier === AccessTier.Private && viewerRole === null) {
      throw hiddenCommunityNotFound();
    }
    try {
      await assertCommunityInteriorReadable({
        community,
        viewerRole,
        communities: this.communities,
        contentModeration: this.contentModeration,
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw hiddenCommunityNotFound();
      throw error;
    }

    const communityRef = {
      slug: community.slug,
      name: community.name,
      avatarImageUrl: toImageUrl(community.avatarImageUrl),
    };
    const existingRow = await this.hiddenCommunities.findOne({
      where: { userId: viewerId, communityId: community.id },
    });
    if (existingRow) {
      return toHiddenEventCommunityResponse(existingRow, communityRef);
    }

    const hiddenCount = await this.hiddenCommunities.count({
      where: { userId: viewerId },
    });
    if (hiddenCount >= HIDDEN_EVENT_COMMUNITIES_LIMIT) {
      throw new ConflictException({
        code: 'HIDDEN_COMMUNITIES_LIMIT_REACHED',
        message: `You can hide events from up to ${HIDDEN_EVENT_COMMUNITIES_LIMIT} communities.`,
        limit: HIDDEN_EVENT_COMMUNITIES_LIMIT,
      });
    }

    // `ON CONFLICT DO NOTHING`: a double tap racing past the read above
    // leaves the existing row as it is and raises no 23505 on the unique pair.
    await this.hiddenCommunities
      .createQueryBuilder()
      .insert()
      .into(HiddenEventCommunity)
      .values({ userId: viewerId, communityId: community.id })
      .orIgnore()
      .execute();
    const storedRow = await this.hiddenCommunities.findOne({
      where: { userId: viewerId, communityId: community.id },
    });
    // Only a concurrent unhide landing between the insert and this read can
    // leave no row; answer with the moment of the hide all the same.
    return toHiddenEventCommunityResponse(
      storedRow ?? { communityId: community.id, createdAt: new Date() },
      communityRef,
    );
  }

  /**
   * `DELETE /me/hidden-event-communities/:communityId`. Idempotent: showing a
   * community that was never hidden already satisfies the member's intent.
   */
  async unhide(
    viewerId: string,
    communityId: string,
  ): Promise<{ hidden: false }> {
    await this.hiddenCommunities.delete({ userId: viewerId, communityId });
    return { hidden: false };
  }
}
