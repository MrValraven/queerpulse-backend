import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deviceLabelFromUserAgent } from '../auth/device-label';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { FlatmateLike } from '../flatmate-profiles/entities/flatmate-like.entity';
import { HousingSavedSearch } from '../housing-saved-searches/entities/housing-saved-search.entity';
import { NotificationDeliveryPreference } from '../notifications/entities/notification-delivery-preference.entity';
import { NotificationPreference } from '../notifications/entities/notification-preference.entity';
import { PushSubscription } from '../push/entities/push-subscription.entity';
import { HiddenFromMember } from '../social/entities/hidden-from.entity';
import { Mute } from '../social/entities/mute.entity';
import { User } from '../users/entities/user.entity';
import { DataExportContribution } from './data-export-contributor';

/**
 * ENG-495 (fix round 1): the account settings and quiet choices a member makes
 * that the Art. 20 archive still skipped, so the export page's promise that
 * the archive holds all the personal data we keep is true. Sessions, push
 * devices, notification settings, mutes, hidden members, flatmate likes and
 * housing saved searches.
 *
 * Same idiom as `data-export-contributors-safety.ts`: one archive key per
 * class, riding on an existing request category, registered through
 * `NEW_DOMAIN_EXPORT_CONTRIBUTORS`. Every row belongs to the member, dates
 * travel as ISO strings (null when unset) and lists are ordered oldest first.
 * Credentials never travel: a session carries no token hash or family id, and
 * a push device carries no endpoint or keys.
 */

/** A nullable timestamp as an ISO string, or null. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * `consent` -> `policyStatus`: the policy stamps kept on the member's `users`
 * row, as one object (null when the row is gone).
 *
 * `policyAcceptances` holds the append-only history, but it starts at ENG-498
 * and signup's Terms acceptance writes no row there. These columns are the
 * record for everything else: the 18+ attestation and the Terms revision it
 * was made against (signup), the guidelines agreement and its revision
 * (onboarding), the affirming housing pledge, and the historical under-18
 * disclosure stamp, which only an account suspended through that former route
 * carries. Each stamp is null when nothing is on record.
 */
@Injectable()
export class PolicyStatusExportContributor implements DataExportContribution {
  readonly category = 'consent';
  readonly archiveKey = 'policyStatus';

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const user = await this.users.findOne({
      select: {
        id: true,
        termsVersion: true,
        ageAttestedAt: true,
        guidelinesVersion: true,
        guidelinesAcceptedAt: true,
        affirmingPledgeAcceptedAt: true,
        underAgeDisclosedAt: true,
      },
      where: { id: userId },
    });
    if (!user) return null;
    return {
      termsVersion: user.termsVersion,
      ageAttestedAt: isoOrNull(user.ageAttestedAt),
      guidelinesVersion: user.guidelinesVersion,
      guidelinesAcceptedAt: isoOrNull(user.guidelinesAcceptedAt),
      affirmingPledgeAcceptedAt: isoOrNull(user.affirmingPledgeAcceptedAt),
      underAgeDisclosedAt: isoOrNull(user.underAgeDisclosedAt),
    };
  }
}

/**
 * `activityLog` -> `sessions`: every sign-in session the member has had,
 * signed out and expired ones included.
 *
 * A session is a family of refresh-token rows: each rotation revokes the old
 * row and mints a new one. So the newest row of each family describes the
 * session: its device, when it was last seen, when it expires and, when the
 * member signed it out, when that happened. Only the columns below are read,
 * so the token hash never leaves the database, and the family id (the
 * session's handle in access tokens) stays out of the archive too.
 */
@Injectable()
export class SessionsExportContributor implements DataExportContribution {
  readonly category = 'activityLog';
  readonly archiveKey = 'sessions';

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.refreshTokens.find({
      select: {
        id: true,
        familyId: true,
        deviceLabel: true,
        userAgent: true,
        sessionStartedAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    // Rows arrive oldest first, so the last row seen for a family is its
    // newest.
    const newestPerFamily = new Map<string, RefreshToken>();
    for (const row of rows) {
      newestPerFamily.set(row.familyId, row);
    }
    return [...newestPerFamily.values()]
      .sort(
        (left, right) =>
          left.sessionStartedAt.getTime() - right.sessionStartedAt.getTime(),
      )
      .map((row) => ({
        id: row.id,
        deviceLabel: row.deviceLabel,
        userAgent: row.userAgent,
        createdAt: row.sessionStartedAt.toISOString(),
        // Rows that predate `lastSeenAt` fall back to the newest mint time,
        // as `AccountService.listSessions` does.
        lastUsedAt: (row.lastSeenAt ?? row.createdAt).toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: isoOrNull(row.revokedAt),
      }));
  }
}

/**
 * `notifications` -> `pushDevices`: the browsers and phones the member turned
 * push notifications on for. The endpoint URL and the two keys are what a
 * sender needs to push to the device, so they are never read; the device
 * travels as its user agent and the readable label the security page uses.
 */
@Injectable()
export class PushDevicesExportContributor implements DataExportContribution {
  readonly category = 'notifications';
  readonly archiveKey = 'pushDevices';

  constructor(
    @InjectRepository(PushSubscription)
    private readonly pushSubscriptions: Repository<PushSubscription>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.pushSubscriptions.find({
      select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true },
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((subscription) => ({
      id: subscription.id,
      deviceLabel: subscription.userAgent
        ? deviceLabelFromUserAgent(subscription.userAgent)
        : null,
      userAgent: subscription.userAgent,
      createdAt: subscription.createdAt.toISOString(),
      lastUsedAt: isoOrNull(subscription.lastUsedAt),
    }));
  }
}

/**
 * `notifications` -> `notificationPreferences`: the member's notification
 * settings as stored. One `type: 'category'` row per category they changed
 * (in-app and push switches), then one `type: 'delivery'` row for quiet hours
 * when they have set them. A category with no row is on its defaults.
 */
@Injectable()
export class NotificationPreferencesExportContributor implements DataExportContribution {
  readonly category = 'notifications';
  readonly archiveKey = 'notificationPreferences';

  constructor(
    @InjectRepository(NotificationPreference)
    private readonly notificationPreferences: Repository<NotificationPreference>,
    @InjectRepository(NotificationDeliveryPreference)
    private readonly deliveryPreferences: Repository<NotificationDeliveryPreference>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [categoryRows, delivery] = await Promise.all([
      this.notificationPreferences.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.deliveryPreferences.findOne({ where: { userId } }),
    ]);
    return [
      ...categoryRows.map((preference) => ({
        type: 'category' as const,
        category: preference.category,
        inApp: preference.inApp,
        push: preference.push,
        createdAt: preference.createdAt.toISOString(),
        updatedAt: preference.updatedAt.toISOString(),
      })),
      ...(delivery
        ? [
            {
              type: 'delivery' as const,
              isQuietHoursEnabled: delivery.isQuietHoursEnabled,
              quietHoursStartMinute: delivery.quietHoursStartMinute,
              quietHoursEndMinute: delivery.quietHoursEndMinute,
              timeZone: delivery.timeZone,
              createdAt: delivery.createdAt.toISOString(),
              updatedAt: delivery.updatedAt.toISOString(),
            },
          ]
        : []),
    ];
  }
}

/**
 * `connections` -> `mutes`: the members this member muted. Read by the muter
 * column alone, so a mute somebody else placed on this member stays in that
 * person's archive.
 */
@Injectable()
export class MutesExportContributor implements DataExportContribution {
  readonly category = 'connections';
  readonly archiveKey = 'mutes';

  constructor(
    @InjectRepository(Mute)
    private readonly mutes: Repository<Mute>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.mutes.find({
      where: { muterId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((mute) => ({
      id: mute.id,
      mutedUserId: mute.mutedId,
      createdAt: mute.createdAt.toISOString(),
    }));
  }
}

/**
 * `connections` -> `hiddenMembers`: the members this member hid their
 * profile from. Read by the owner column alone, so a hide somebody else placed
 * on this member stays in that person's archive and never tells this member
 * who hid from them.
 */
@Injectable()
export class HiddenMembersExportContributor implements DataExportContribution {
  readonly category = 'connections';
  readonly archiveKey = 'hiddenMembers';

  constructor(
    @InjectRepository(HiddenFromMember)
    private readonly hiddenFromMembers: Repository<HiddenFromMember>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.hiddenFromMembers.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((hidden) => ({
      id: hidden.id,
      hiddenFromUserId: hidden.hiddenFromUserId,
      createdAt: hidden.createdAt.toISOString(),
    }));
  }
}

/**
 * `housing` -> `flatmateLikes`: the like and pass decisions the member made
 * on other flatmate profiles. Read by the deciding member alone, so who liked
 * this member's profile stays in each of their own archives.
 */
@Injectable()
export class FlatmateLikesExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'flatmateLikes';

  constructor(
    @InjectRepository(FlatmateLike)
    private readonly flatmateLikes: Repository<FlatmateLike>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.flatmateLikes.find({
      where: { fromUserId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((like) => ({
      id: like.id,
      toProfileId: like.toProfileId,
      decision: like.decision,
      createdAt: like.createdAt.toISOString(),
      updatedAt: like.updatedAt.toISOString(),
    }));
  }
}

/**
 * `housing` -> `savedSearches`: the housing searches the member saved, with
 * their criteria and whether alerts are on.
 */
@Injectable()
export class HousingSavedSearchesExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'savedSearches';

  constructor(
    @InjectRepository(HousingSavedSearch)
    private readonly housingSavedSearches: Repository<HousingSavedSearch>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.housingSavedSearches.find({
      where: { memberId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((search) => ({
      id: search.id,
      name: search.name,
      criteria: search.criteria,
      alertsEnabled: search.alertsEnabled,
      createdAt: search.createdAt.toISOString(),
      updatedAt: search.updatedAt.toISOString(),
    }));
  }
}
