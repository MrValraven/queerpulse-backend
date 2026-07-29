import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { extractMentions } from '../common/mentions';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Community } from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Profile } from '../users/entities/profile.entity';

type EntityKind = 'member' | 'community' | 'business' | 'event' | 'thread';

@Injectable()
export class MentionNotificationService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    private readonly notifications: NotificationsService,
  ) {}

  /** Best-effort mention fan-out across every entity kind. One notification per
   *  recipient per post — member > community > business > event > thread priority,
   *  author always dropped. Never throws: a mention side effect must not fail a write. */
  async notify(
    body: string,
    authorUserId: string,
    payloadBase: Record<string, unknown>,
  ): Promise<void> {
    try {
      const mentions = extractMentions(body);
      const groups: { kind: EntityKind; ref: string; recipients: string[] }[] =
        [];

      if (mentions.members.length) {
        const bySlug = await new MemberLookup(this.profiles).userIdsForSlugs(
          mentions.members,
        );
        for (const [slug, userId] of bySlug) {
          groups.push({ kind: 'member', ref: slug, recipients: [userId] });
        }
      }
      if (mentions.communities.length) {
        const communityRows = await this.communities.find({
          where: { slug: In(mentions.communities) },
        });
        const communityBySlug = new Map(
          communityRows.map((community) => [community.slug, community]),
        );
        const staffRows = communityRows.length
          ? await this.members.find({
              where: {
                communityId: In(communityRows.map((community) => community.id)),
                role: In([RosterRole.Owner, RosterRole.Mod]),
              },
            })
          : [];
        const staffByCommunityId = new Map<string, string[]>();
        for (const staff of staffRows) {
          const userIds = staffByCommunityId.get(staff.communityId) ?? [];
          userIds.push(staff.userId);
          staffByCommunityId.set(staff.communityId, userIds);
        }
        // Iterate in mention order (not DB order) so cross-mention priority
        // stays deterministic.
        for (const slug of mentions.communities) {
          const community = communityBySlug.get(slug);
          if (!community) continue;
          const recipients = Array.from(
            new Set([
              community.ownerId,
              ...(staffByCommunityId.get(community.id) ?? []),
            ]),
          );
          groups.push({ kind: 'community', ref: slug, recipients });
        }
      }
      if (mentions.businesses.length) {
        const listingRows = await this.listings.find({
          where: { slug: In(mentions.businesses) },
        });
        const ownerBySlug = new Map(
          listingRows.map((listing) => [listing.slug, listing.ownerId]),
        );
        for (const slug of mentions.businesses) {
          const ownerId = ownerBySlug.get(slug);
          if (ownerId === undefined) continue;
          groups.push({ kind: 'business', ref: slug, recipients: [ownerId] });
        }
      }
      if (mentions.events.length) {
        const eventRows = await this.events.find({
          where: { slug: In(mentions.events) },
        });
        const hostBySlug = new Map(
          eventRows.map((event) => [event.slug, event.hostId]),
        );
        for (const slug of mentions.events) {
          const hostId = hostBySlug.get(slug);
          if (hostId === undefined) continue;
          groups.push({ kind: 'event', ref: slug, recipients: [hostId] });
        }
      }
      if (mentions.threads.length) {
        const threadRows = await this.threads.find({
          where: { slug: In(mentions.threads) },
        });
        const authorBySlug = new Map(
          threadRows.map((thread) => [thread.slug, thread.authorId]),
        );
        for (const slug of mentions.threads) {
          const authorId = authorBySlug.get(slug);
          if (authorId === undefined) continue;
          groups.push({ kind: 'thread', ref: slug, recipients: [authorId] });
        }
      }

      // One notification per recipient per post: the first (highest-priority)
      // group that names a user wins; the author is never notified.
      const claimed = new Set<string>([authorUserId]);
      for (const group of groups) {
        const recipients = group.recipients.filter(
          (userId) => !!userId && !claimed.has(userId),
        );
        if (!recipients.length) continue;
        recipients.forEach((userId) => claimed.add(userId));
        await this.notifications.createForRecipients(
          recipients,
          NotificationType.Mention,
          { ...payloadBase, entityKind: group.kind, entityRef: group.ref },
          authorUserId,
        );
      }
    } catch {
      // Intentionally ignored — mention notifications are best-effort.
    }
  }
}
