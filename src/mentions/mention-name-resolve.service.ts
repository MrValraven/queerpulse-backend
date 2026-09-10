import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import type { ResolvedMentionNameResponse } from './dto/resolved-mention-name.response';
import {
  MENTION_NAME_KINDS,
  type MentionNameKind,
} from './dto/resolve-mention-names.query';

/**
 * Names the entities a body of text mentions, so a reader sees "Val Raven"
 * where the author typed `@val-raven`.
 *
 * Read-only and viewer-scoped. Every kind is filtered to what that viewer could
 * already reach by its own route, so this never becomes a side door onto a name
 * the platform otherwise withholds:
 *
 *  - `member` — active users only, mirroring `MemberLookup.userIdsForSlugs`
 *    (and `ProfilesService.searchMembers`). A suspended or erased account keeps
 *    its raw `@slug`.
 *  - `community` — every tier except `private`, unless the viewer is on that
 *    private community's roster. Same predicate as `browseBaseQuery`'s
 *    `discover` filter, so a private community's existence stays unleaked.
 *  - `business` — `live` listings only; `review`/`question` are moderation
 *    states the public directory doesn't serve.
 *  - `event` — `published` only, matching every public events read.
 *  - `thread` — not deleted, and either a global forum thread or one inside a
 *    community the viewer can see. The community test here is the stricter of
 *    the two (public tier OR roster member), mirroring
 *    `MentionNotificationService.recipientsAllowedForSource`: a thread title
 *    written inside a request/invite/private community is gated content.
 *
 * Unresolvable refs are simply omitted — the client renders the raw
 * `sigil + slug` it already parsed, which is the pre-existing behaviour.
 */
@Injectable()
export class MentionNameResolveService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
  ) {}

  async resolve(
    viewerId: string,
    refs: string[],
  ): Promise<ResolvedMentionNameResponse[]> {
    const slugsByKind = groupSlugsByKind(refs);

    // Five independent reads of the same committed snapshot — they go out
    // together rather than in series. Each is skipped entirely when the text
    // mentioned nothing of that kind.
    const [memberRows, communityRows, listingRows, eventRows, threadRows] =
      await Promise.all([
        this.findBySlugs(this.kindSlugs(slugsByKind, 'member'), (slugs) =>
          this.profiles
            .createQueryBuilder('p')
            .innerJoin('p.user', 'u', 'u.status = :active', {
              active: UserStatus.Active,
            })
            .where('p.slug IN (:...slugs)', { slugs })
            .getMany(),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'community'), (slugs) =>
          this.communities.find({ where: { slug: In(slugs) } }),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'business'), (slugs) =>
          this.listings.find({
            where: { slug: In(slugs), status: ListingStatus.Live },
          }),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'event'), (slugs) =>
          this.events.find({
            where: { slug: In(slugs), status: EventStatus.Published },
          }),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'thread'), (slugs) =>
          this.threads.find({
            where: { slug: In(slugs), deletedAt: IsNull() },
          }),
        ),
      ]);

    // A thread's own gate needs its community's tier, which the thread row only
    // points at by id — so those communities are read here rather than in the
    // fan-out above, and both gates then share one roster lookup.
    const threadCommunityIds = threadRows
      .map((thread) => thread.communityId)
      .filter((id): id is string => id !== null);
    const threadCommunities = threadCommunityIds.length
      ? await this.communities.find({ where: { id: In(threadCommunityIds) } })
      : [];
    const communityById = new Map(
      [...communityRows, ...threadCommunities].map((community) => [
        community.id,
        community,
      ]),
    );
    const viewerCommunityIds = await this.rosterMembershipsOf(
      viewerId,
      Array.from(communityById.keys()),
    );

    const named: ResolvedMentionNameResponse[] = [];
    for (const profile of memberRows) {
      const name = `${profile.firstName} ${profile.lastName}`.trim();
      if (name) named.push({ kind: 'member', slug: profile.slug, name });
    }
    for (const community of communityRows) {
      // Browse-visibility: every tier but `private`, plus a private community
      // the viewer is actually in.
      const isVisible =
        community.accessTier !== AccessTier.Private ||
        viewerCommunityIds.has(community.id);
      if (isVisible && community.name) {
        named.push({
          kind: 'community',
          slug: community.slug,
          name: community.name,
        });
      }
    }
    for (const listing of listingRows) {
      if (listing.name) {
        named.push({
          kind: 'business',
          slug: listing.slug,
          name: listing.name,
        });
      }
    }
    for (const event of eventRows) {
      if (event.title) {
        named.push({ kind: 'event', slug: event.slug, name: event.title });
      }
    }
    for (const thread of threadRows) {
      if (!thread.title) continue;
      if (thread.communityId !== null) {
        const community = communityById.get(thread.communityId);
        // Gated-content rule, stricter than the community's own name gate: a
        // title written inside a non-public community reaches its roster only.
        // An unresolvable community fails CLOSED — unlike the notification
        // fan-out's equivalent, nothing here is time-critical, so the safe
        // answer is to leave the raw `t/slug` standing.
        const isVisible =
          !!community &&
          (community.accessTier === AccessTier.Public ||
            viewerCommunityIds.has(community.id));
        if (!isVisible) continue;
      }
      named.push({ kind: 'thread', slug: thread.slug, name: thread.title });
    }
    return named;
  }

  /** Skips the read entirely when nothing of that kind was mentioned. */
  private async findBySlugs<T>(
    slugs: string[],
    read: (slugs: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    return slugs.length ? read(slugs) : [];
  }

  private kindSlugs(
    slugsByKind: Map<MentionNameKind, string[]>,
    kind: MentionNameKind,
  ): string[] {
    return slugsByKind.get(kind) ?? [];
  }

  /** The subset of `communityIds` the viewer is on the roster of. */
  private async rosterMembershipsOf(
    viewerId: string,
    communityIds: string[],
  ): Promise<Set<string>> {
    if (!communityIds.length) return new Set();
    const memberships = await this.communityMembers.find({
      where: { userId: viewerId, communityId: In(communityIds) },
      select: { communityId: true },
    });
    return new Set(memberships.map((membership) => membership.communityId));
  }
}

/** `["member:ana", "member:bo", "event:pride"]` -> `{member: [ana, bo], …}`,
 *  de-duplicated. The query DTO has already rejected any ref that isn't a known
 *  `kind:slug`, so the split below cannot produce an unknown kind. */
function groupSlugsByKind(refs: string[]): Map<MentionNameKind, string[]> {
  const slugsByKind = new Map<MentionNameKind, string[]>();
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const separatorIndex = ref.indexOf(':');
    const kind = ref.slice(0, separatorIndex) as MentionNameKind;
    const slug = ref.slice(separatorIndex + 1);
    if (!MENTION_NAME_KINDS.includes(kind) || !slug) continue;
    const slugs = slugsByKind.get(kind) ?? [];
    slugs.push(slug);
    slugsByKind.set(kind, slugs);
  }
  return slugsByKind;
}
