import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  COMMUNITY_MEMBER_JOINED,
  COMMUNITY_MEMBER_LEFT,
  COMMUNITY_POST_CREATED,
  CommunityMemberJoinedEvent,
  CommunityMemberLeftEvent,
  CommunityPostCreatedEvent,
} from '../communities/community.events';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { EVENT_RSVPED, EventRsvpedEvent } from '../events/event.events';
import { EventVisibility } from '../events/entities/event.entity';
import {
  FORUM_THREAD_CREATED,
  ForumThreadCreatedEvent,
} from '../forum/forum.events';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';
import { ActivityService } from './activity.service';
import {
  communityPath,
  communityPostPath,
  gatheringPath,
  nestedPersonaPath,
  threadPath,
} from './activity-links';

/**
 * The event name a persona publish will be announced under.
 *
 * Declared here as a string rather than imported from
 * `subprofiles/subprofile.events.ts` because that file belongs to the
 * subprofiles feature and this build does not modify it. The emit is a
 * one-line addition at the end of `SubprofilesService.publish` and is raised
 * as a coordination item; until it lands this handler simply never fires and
 * nothing else is affected. Keep the literal in sync with the constant when
 * that file gains one.
 */
export const SUBPROFILE_PUBLISHED = 'subprofile.published';

/** What `SUBPROFILE_PUBLISHED` carries: the persona that just went live. */
export interface SubprofilePublishedEvent {
  subprofileId: string;
  ownerUserId: string;
}

/**
 * Turns genuine, publicly-visible member actions into profile "Recent activity"
 * rows by listening to the domain events those actions already emit.
 *
 * PRIVACY IS ENFORCED AT BOTH ENDS. At the WRITE, here: a single activity row
 * is served to every audience — the member themselves, another signed-in
 * member, and (once published) the open web via the public-profile endpoint —
 * so a row is only ever recorded for an action that is already publicly
 * visible on the platform:
 *   - RSVPs to `public`-visibility events (members-only / invite-only events
 *     are dropped — attending them is not a public fact),
 *   - forum threads (the forum is a members-wide public square),
 *   - posts in `public`-tier communities (request/invite/private are dropped),
 *   - joining a `public`-tier community (same gate: being IN a private space
 *     is exactly the fact a private space exists to keep),
 *   - publishing an `open`, published persona.
 * Nothing from a members-only, invite-only or private space is ever written,
 * so a member's activity can never disclose a space they'd want kept quiet.
 *
 * At the READ, in `ActivityVisibilityService`: the write gate only knows the
 * subject's visibility at the instant of the action, and a subject can be made
 * private later. Every row therefore stores a `subjectKind`/`subjectId`
 * reference so the read path can re-check it and drop (and purge) rows whose
 * subject has stopped being public. That is why the writes below always set
 * the subject pair alongside the link.
 *
 * Deep links ARE stored, for subjects that are already public: a row states a
 * public fact and hands the reader the same public page anyone could reach by
 * browsing. The one exception is the anonymous public-profile endpoint, which
 * drops `toLink` on its own way out (see `PublicActivityView`) so a logged-out
 * visitor still gets no map of in-app URLs.
 */
@Injectable()
export class ActivityListener {
  constructor(
    private readonly activity: ActivityService,
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

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
      toLink: gatheringPath(event.eventSlug),
      subjectKind: ActivitySubjectKind.Event,
      subjectId: event.eventSlug,
    });
  }

  @OnEvent(FORUM_THREAD_CREATED)
  async onForumThreadCreated(event: ForumThreadCreatedEvent): Promise<void> {
    await this.activity.record({
      userId: event.authorId,
      kind: ActivityKind.Post,
      title: `Started a thread: ${event.title}`,
      sub: 'In the forum',
      toLink: threadPath(event.threadSlug),
      // No subject reference on purpose: a forum thread has no visibility
      // dimension to re-check (see the class doc and `ForumThreadCreatedEvent`).
      subjectKind: null,
      subjectId: null,
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
      toLink: communityPostPath(event.communitySlug, event.postId),
      // The COMMUNITY is the subject to re-check, not the post: the post's
      // readability is entirely a function of the community's access tier, and
      // a community turning private must take every post row with it.
      subjectKind: ActivitySubjectKind.Community,
      subjectId: event.communitySlug,
    });
  }

  /**
   * Joining a PUBLIC community. The join event carries only ids, so the
   * community is loaded here to read its access tier and name — the same gate
   * `onCommunityPostCreated` gets handed on its event.
   */
  @OnEvent(COMMUNITY_MEMBER_JOINED)
  async onCommunityMemberJoined(
    event: CommunityMemberJoinedEvent,
  ): Promise<void> {
    const community = await this.communities.findOne({
      where: { id: event.communityId },
    });
    if (
      !community ||
      community.accessTier !== AccessTier.Public ||
      community.archivedAt
    ) {
      return;
    }
    await this.activity.record({
      userId: event.userId,
      kind: ActivityKind.Community,
      title: `Joined ${community.name}`,
      sub: null,
      toLink: communityPath(community.slug),
      subjectKind: ActivitySubjectKind.Community,
      subjectId: community.slug,
    });
  }

  /**
   * Leaving a community retracts the join row immediately, rather than waiting
   * for the read-time gate: the community may well still be public, so nothing
   * would drop it, and "Joined X" is false the moment the member is off the
   * roster. Only the join row is removed; posts the member made while a member
   * are still things that happened in a public space.
   */
  @OnEvent(COMMUNITY_MEMBER_LEFT)
  async onCommunityMemberLeft(event: CommunityMemberLeftEvent): Promise<void> {
    const community = await this.communities.findOne({
      where: { id: event.communityId },
    });
    if (!community) {
      return;
    }
    await this.activities.delete({
      userId: event.userId,
      kind: ActivityKind.Community,
      subjectKind: ActivitySubjectKind.Community,
      subjectId: community.slug,
    });
  }

  /**
   * Publishing a persona. Re-reads the persona rather than trusting the event
   * payload, because "published" alone is not enough: a `network`- or
   * `private`-visibility persona is published and still not a public fact, and
   * this row is served to audiences as wide as the open web.
   */
  @OnEvent(SUBPROFILE_PUBLISHED)
  async onSubprofilePublished(event: SubprofilePublishedEvent): Promise<void> {
    const persona = await this.subprofiles.findOne({
      where: {
        id: event.subprofileId,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        removedAt: IsNull(),
      },
    });
    if (!persona) {
      return;
    }
    const link = await this.personaLink(persona);
    if (!link) {
      return;
    }
    await this.activity.record({
      userId: persona.userId,
      kind: ActivityKind.Persona,
      title: `Published a persona: ${persona.displayName}`,
      sub: null,
      toLink: link,
      subjectKind: ActivitySubjectKind.Persona,
      subjectId: persona.id,
    });
  }

  /**
   * Where a published persona lives publicly: nested under its owner's main
   * profile.
   *
   * An UNLINKED persona gets no link and therefore no activity row at all,
   * which is the point: unlinked means the persona is deliberately not tied
   * back to the member, and a row on the member's own profile announcing they
   * published it would undo that with the member's own byline. It reaches the
   * public at `/p/<handle>` on its own, without the connection.
   */
  private async personaLink(persona: Subprofile): Promise<string | null> {
    if (persona.linkVisibility !== SubprofileLinkVisibility.Linked) {
      return null;
    }
    const owner = await this.profiles.findOne({
      where: { userId: persona.userId },
    });
    return owner ? nestedPersonaPath(owner.slug, persona.slug) : null;
  }
}
