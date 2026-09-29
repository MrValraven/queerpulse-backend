import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventBan } from '../events/entities/event-ban.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  VerificationLevel,
  meetsLevel,
} from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { EventMatchConfig } from './entities/event-match-config.entity';

const HOUR_MS = 60 * 60 * 1000;
export const OPT_IN_CLOSE_MS = 6 * HOUR_MS;
export const DEFAULT_CUTOFF_MS = 48 * HOUR_MS;
export const MAX_CUTOFF_LEAD_MS = 7 * 24 * HOUR_MS;

export type MemberBlocker =
  'inactive' | 'restricted' | 'bannedFromEvent' | 'notGoing' | 'notVerified';
export type EventBlocker = 'notEnabled' | 'eventNotPublished' | 'closed';

export function optInClosesAt(event: Pick<Event, 'startAt'>): Date {
  return new Date(event.startAt.getTime() - OPT_IN_CLOSE_MS);
}

/**
 * The matching time that actually applies. `cutoffAt` is saved when the host
 * configures matching, and the gathering can move afterwards, so it is clamped
 * against the current start into the allowed range (7 days to 6 hours before
 * the start). The cutoff claim in `go-together-matching.service.ts`
 * (`EFFECTIVE_CUTOFF_REACHED`) applies the same clamp in SQL.
 */
export function effectiveCutoffAt(cutoffAt: Date, startAt: Date): Date {
  const startMs = startAt.getTime();
  return new Date(
    Math.min(
      Math.max(cutoffAt.getTime(), startMs - MAX_CUTOFF_LEAD_MS),
      startMs - OPT_IN_CLOSE_MS,
    ),
  );
}

/** Lead time a default matching time always leaves for members to opt in. */
export const MIN_DEFAULT_CUTOFF_LEAD_MS = HOUR_MS;

/**
 * The matching time used when the host picks none: 48 hours before the start,
 * moved to one hour from now when that has passed, and capped at the moment
 * opt-in closes. Callers that need a future value check `optInClosesAt` first.
 */
export function defaultCutoffAt(startAt: Date, now: Date): Date {
  const startMs = startAt.getTime();
  const preferredMs = Math.max(
    startMs - DEFAULT_CUTOFF_MS,
    now.getTime() + MIN_DEFAULT_CUTOFF_LEAD_MS,
  );
  return new Date(Math.min(preferredMs, startMs - OPT_IN_CLOSE_MS));
}

/**
 * Who may be matched with strangers. Batched so the reconcile pass can check
 * a whole pool in five queries. Verified means the admin badge
 * (`profiles.verified`) OR at least phone verification level.
 */
@Injectable()
export class GoTogetherEligibilityService {
  constructor(
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventBan) private readonly bans: Repository<EventBan>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly verification: VerificationService,
  ) {}

  eventBlocker(
    event: Pick<Event, 'status' | 'startAt'>,
    config: Pick<EventMatchConfig, 'enabled'> | null,
    now: Date = new Date(),
  ): EventBlocker | null {
    if (!config?.enabled) return 'notEnabled';
    if (event.status !== EventStatus.Published) return 'eventNotPublished';
    if (now.getTime() >= optInClosesAt(event).getTime()) return 'closed';
    return null;
  }

  async memberBlockers(
    eventId: string,
    userIds: string[],
    now: Date = new Date(),
  ): Promise<Map<string, MemberBlocker>> {
    const uniqueUserIds = [...new Set(userIds)];
    const blockers = new Map<string, MemberBlocker>();
    if (uniqueUserIds.length === 0) return blockers;
    const [rsvpRows, banRows, userRows, profileRows, levels] =
      await Promise.all([
        this.rsvps.find({
          where: { eventId, userId: In(uniqueUserIds) },
          select: { userId: true, status: true, removedByHostAt: true },
        }),
        this.bans.find({
          where: { eventId, userId: In(uniqueUserIds) },
          select: { userId: true },
        }),
        this.users.find({
          where: { id: In(uniqueUserIds) },
          select: {
            id: true,
            status: true,
            restricted: true,
            restrictedUntil: true,
          },
        }),
        this.profiles.find({
          where: { userId: In(uniqueUserIds) },
          select: { userId: true, verified: true },
        }),
        this.verification.levelsForUsers(uniqueUserIds),
      ]);
    const rsvpByUser = new Map(rsvpRows.map((row) => [row.userId, row]));
    const bannedUserIds = new Set(banRows.map((row) => row.userId));
    const userById = new Map(userRows.map((row) => [row.id, row]));
    const badgeVerifiedUserIds = new Set(
      profileRows.filter((row) => row.verified).map((row) => row.userId),
    );

    for (const userId of uniqueUserIds) {
      const user = userById.get(userId);
      const rsvp = rsvpByUser.get(userId);
      // `restricted` expires lazily, so a past `restrictedUntil` counts as lifted.
      const isRestricted =
        user?.restricted === true &&
        (user.restrictedUntil === null ||
          user.restrictedUntil.getTime() > now.getTime());
      const isVerified =
        badgeVerifiedUserIds.has(userId) ||
        meetsLevel(
          levels.get(userId) ?? VerificationLevel.Email,
          VerificationLevel.Phone,
        );
      if (!user || user.status !== UserStatus.Active) {
        blockers.set(userId, 'inactive');
      } else if (isRestricted) {
        blockers.set(userId, 'restricted');
      } else if (bannedUserIds.has(userId)) {
        blockers.set(userId, 'bannedFromEvent');
      } else if (
        !rsvp ||
        rsvp.status !== RsvpStatus.Going ||
        rsvp.removedByHostAt !== null
      ) {
        blockers.set(userId, 'notGoing');
      } else if (!isVerified) {
        blockers.set(userId, 'notVerified');
      }
    }
    return blockers;
  }
}
