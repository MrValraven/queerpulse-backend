import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { toImageUrl } from '../common/image-url';
import { PublicCommunityResponse } from './community-public-response';
import { CommunityMember } from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

/**
 * The only access tiers a signed-out teaser can ever describe. `invite` and
 * `private` are excluded structurally, not by a flag: being findable is
 * incompatible with those tiers by definition, so even a community whose
 * `is_publicly_listed` somehow got set to true while sitting on one of them
 * stays a 404 here.
 */
const PUBLICLY_TEASABLE_TIERS: readonly AccessTier[] = [
  AccessTier.Public,
  AccessTier.Request,
];

/**
 * Backs `GET /communities/:slug/public` — the signed-out teaser behind a
 * shared community link, which today is a sign-in wall with no context.
 *
 * The product decision this encodes is OWNER OPT-IN, DEFAULT OFF. Three
 * conditions must ALL hold or the endpoint 404s, and 404 (never 403) is the
 * answer in every failing case so the endpoint never confirms that a
 * non-listed community exists:
 *   1. `is_publicly_listed` is true (the owner turned it on),
 *   2. the access tier is `public` or `request`,
 *   3. the community is not archived.
 *
 * What comes back is `PublicCommunityResponse` and nothing else. Read that
 * type's comment before adding a field: the roster, the owner's identity,
 * every post, and the rules text are all excluded deliberately.
 */
@Injectable()
export class CommunityPublicService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
  ) {}

  async getPublicTeaser(slug: string): Promise<PublicCommunityResponse> {
    // One indexed lookup on the unique slug, with all three gates in the
    // WHERE clause so a community that fails any of them is simply not found.
    const community = await this.communities.findOne({
      where: {
        slug,
        isPubliclyListed: true,
        archivedAt: IsNull(),
      },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    // The tier gate is applied here rather than inlined above only because
    // TypeORM's `In` on an enum column reads worse than the explicit check;
    // the effect is identical, and the answer is the same 404.
    if (!PUBLICLY_TEASABLE_TIERS.includes(community.accessTier)) {
      throw new NotFoundException('Community not found');
    }

    // Two more queries, run together: a COUNT over the roster (a number, never
    // any member's identity) and the single next public gathering. Both are
    // scoped to this one community, so the endpoint costs three queries flat.
    const now = new Date();
    const [memberCount, nextGathering] = await Promise.all([
      this.members.count({ where: { communityId: community.id } }),
      this.events.findOne({
        where: {
          communityId: community.id,
          status: EventStatus.Published,
          // PUBLIC visibility only. A `members`, `community`, `network` or
          // `invite_only` gathering is not something a signed-out visitor may
          // learn exists, so the filter is an equality on `public` rather than
          // an exclusion list that a new visibility tier could quietly widen.
          visibility: EventVisibility.Public,
          startAt: MoreThanOrEqual(now),
        },
        order: { startAt: 'ASC' },
        select: {
          id: true,
          slug: true,
          title: true,
          startAt: true,
          isOnline: true,
        },
      }),
    ]);

    return {
      slug: community.slug,
      name: community.name,
      tagline: community.tagline,
      purpose: community.purpose,
      type: community.type,
      accessTier: community.accessTier,
      tags: community.tags ?? [],
      city: community.city,
      area: community.area,
      isOnline: community.isOnline,
      languages: community.languages ?? [],
      memberCount,
      avatarImageUrl: toImageUrl(community.avatarImageUrl),
      coverImageUrl: toImageUrl(community.coverImageUrl),
      nextGathering: nextGathering
        ? {
            slug: nextGathering.slug,
            title: nextGathering.title,
            startAt: nextGathering.startAt,
            isOnline: nextGathering.isOnline,
          }
        : null,
    };
  }
}
