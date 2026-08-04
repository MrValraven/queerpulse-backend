import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  COMMUNITY_POST_CREATED,
  CommunityPostCreatedEvent,
} from '../communities/community.events';
import { AccessTier } from '../communities/entities/community.entity';
import { EVENT_RSVPED, EventRsvpedEvent } from '../events/event.events';
import { EventVisibility } from '../events/entities/event.entity';
import {
  FORUM_THREAD_CREATED,
  ForumThreadCreatedEvent,
} from '../forum/forum.events';
import { ActivityKind } from './entities/activity.entity';
import { ActivityService } from './activity.service';

/**
 * Turns genuine, publicly-visible member actions into profile "Recent activity"
 * rows by listening to the domain events those actions already emit.
 *
 * PRIVACY IS ENFORCED AT THE WRITE, not at the read: a single activity row is
 * served to every audience — the member themselves, another signed-in member,
 * and (once published) the open web via the public-profile endpoint — so a row
 * must be safe for the widest of those. Therefore this listener records ONLY
 * actions that are already publicly visible on the platform:
 *   - RSVPs to `public`-visibility events (members-only / invite-only events
 *     are dropped — attending them is not a public fact),
 *   - forum threads (the forum is a members-wide public square),
 *   - posts in `public`-tier communities (request/invite/private are dropped).
 * Nothing from a members-only, invite-only or private space is ever written,
 * so a member's activity can never disclose a space they'd want kept quiet.
 *
 * Deep links are deliberately NOT stored for these rows: `toLink` is left null
 * so the frontend renders a static entry. The activity feed states the fact of
 * a public action; it is not a directory of the member's in-app URLs.
 */
@Injectable()
export class ActivityListener {
  constructor(private readonly activity: ActivityService) {}

  @OnEvent(EVENT_RSVPED)
  async onEventRsvped(event: EventRsvpedEvent): Promise<void> {
    // Only a public event's attendance is a public fact. A members-only or
    // invite-only event is a space the member may not want advertised, and its
    // very existence could out them — never record it.
    if (event.eventVisibility !== EventVisibility.Public) {
      return;
    }
    await this.activity.record({
      userId: event.rsvperId,
      kind: ActivityKind.Event,
      title: `RSVP'd to ${event.eventTitle}`,
      sub: null,
      toLink: null,
    });
  }

  @OnEvent(FORUM_THREAD_CREATED)
  async onForumThreadCreated(event: ForumThreadCreatedEvent): Promise<void> {
    await this.activity.record({
      userId: event.authorId,
      kind: ActivityKind.Post,
      title: `Started a thread: ${event.title}`,
      sub: 'In the forum',
      toLink: null,
    });
  }

  @OnEvent(COMMUNITY_POST_CREATED)
  async onCommunityPostCreated(
    event: CommunityPostCreatedEvent,
  ): Promise<void> {
    // A post only counts as public activity when the community itself is
    // public; request/invite/private communities are private spaces and their
    // posts must never surface on a profile (see the event's doc comment).
    if (event.accessTier !== AccessTier.Public) {
      return;
    }
    await this.activity.record({
      userId: event.authorId,
      kind: ActivityKind.Post,
      title: `Posted in ${event.communityName}`,
      sub: event.excerpt || null,
      toLink: null,
    });
  }
}
