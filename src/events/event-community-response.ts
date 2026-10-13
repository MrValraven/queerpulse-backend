import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  CohostInviteEventSummaryView,
  CohostInviteInviterView,
  toCohostInviteEventSummaryView,
} from './cohost-invite-response';
import {
  EventCommunity,
  EventCommunityStatus,
} from './entities/event-community.entity';
import { Event } from './entities/event.entity';
import { LeadCommunityRef } from './event-community-hosting';

/** The guest community as every guest surface names it. */
export interface EventGuestCommunityRef {
  slug: string;
  name: string;
  accessTier: AccessTier;
}

/** `GET`/`POST /events/:slug/communities`: one guest row for the editor. */
export interface EventGuestCommunityView {
  id: string;
  status: EventCommunityStatus;
  community: EventGuestCommunityRef;
}

/** The gathering card on the invite page, with the two closed states. */
export interface EventCommunityInviteEventView extends CohostInviteEventSummaryView {
  isCancelled: boolean;
  isPast: boolean;
}

/** `GET /event-communities/:id` and the answer to `POST .../respond`. */
export interface EventCommunityInviteDetailView {
  id: string;
  status: EventCommunityStatus;
  createdAt: Date;
  respondedAt: Date | null;
  /** Display name of the owner, co-owner or mod who answered. */
  respondedByName: string | null;
  community: EventGuestCommunityRef;
  /** Null when the gathering has no lead or the lead is withheld. */
  leadCommunity: LeadCommunityRef | null;
  event: EventCommunityInviteEventView;
  /** Null once the inviter's account is gone. */
  inviter: CohostInviteInviterView | null;
  canRespond: boolean;
  canLeave: boolean;
}

export interface EventCommunityInviteDetailInput {
  invite: Pick<EventCommunity, 'id' | 'status' | 'createdAt' | 'respondedAt'>;
  event: Event;
  community: Pick<Community, 'slug' | 'name' | 'accessTier'>;
  leadCommunity: LeadCommunityRef | null;
  goingCount: number | null;
  waitlistCount: number | null;
  inviter: CohostInviteInviterView | null;
  respondedByName: string | null;
  isCancelled: boolean;
  isPast: boolean;
  canRespond: boolean;
  canLeave: boolean;
}

export function toEventGuestCommunityRef(
  community: Pick<Community, 'slug' | 'name' | 'accessTier'>,
): EventGuestCommunityRef {
  return {
    slug: community.slug,
    name: community.name,
    accessTier: community.accessTier,
  };
}

export function toEventGuestCommunityView(
  row: Pick<EventCommunity, 'id' | 'status'>,
  community: Pick<Community, 'slug' | 'name' | 'accessTier'>,
): EventGuestCommunityView {
  return {
    id: row.id,
    status: row.status,
    community: toEventGuestCommunityRef(community),
  };
}

export function toEventCommunityInviteDetailView(
  input: EventCommunityInviteDetailInput,
): EventCommunityInviteDetailView {
  return {
    id: input.invite.id,
    status: input.invite.status,
    createdAt: input.invite.createdAt,
    respondedAt: input.invite.respondedAt,
    respondedByName: input.respondedByName,
    community: toEventGuestCommunityRef(input.community),
    leadCommunity: input.leadCommunity,
    event: {
      ...toCohostInviteEventSummaryView(
        input.event,
        input.goingCount,
        input.waitlistCount,
      ),
      isCancelled: input.isCancelled,
      isPast: input.isPast,
    },
    inviter: input.inviter,
    canRespond: input.canRespond,
    canLeave: input.canLeave,
  };
}

/** "Rui Matos", or null for a profile with neither name set. */
export function displayNameOf(
  profile: Pick<Profile, 'firstName' | 'lastName'>,
): string | null {
  return (
    [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null
  );
}
