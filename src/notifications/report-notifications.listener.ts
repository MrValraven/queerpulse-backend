import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Event as Gathering } from '../events/entities/event.entity';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { REPORT_CREATED, ReportCreatedEvent } from '../reports/report.events';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { NotificationType } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

/**
 * Report `subjectId` is a varchar carrying whatever addresses the subject: a
 * uuid for a post/reply, a slug for a community, either for a member. A
 * non-uuid value would 500 a uuid-typed lookup, so it is filtered before any
 * id query. Same guard `CommunityAutoFreezeService` and
 * `CommunityMembershipService` each keep their own copy of.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The roster roles that answer for a community's content (TS-04 fan-out). */
const COMMUNITY_STAFF_ROLES: readonly RosterRole[] = [
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
];

/**
 * The two things a reported photograph tells this listener, read together
 * because they come out of one row (TS-13).
 *
 * Both are independently nullable and both mean something specific:
 * `communityId` is null for a gathering that belongs to no community, so the
 * report stays platform-only; `uploaderId` is null for a member who erased
 * their account (`event_photos.uploader_id` is `ON DELETE SET NULL`), so there
 * is simply nobody to leave out of the fan-out.
 */
interface EventPhotoSubject {
  /** The community hosting the gathering whose album the photo is in. */
  communityId: string | null;
  /** The member who attached the photograph. */
  uploaderId: string | null;
}

/**
 * Tells the people who can act on a report that one has landed (TS-04).
 *
 * Before this, filing a report emitted `REPORT_CREATED` and notified nobody:
 * the only signal was a count pill inside the admin console, so the platform's
 * 1-hour outing/doxxing SLA held only while someone happened to have the queue
 * open. Nights and weekends were uncovered.
 *
 * A SECOND listener on `REPORT_CREATED` (alongside
 * `CommunityAutoFreezeService`), rather than a call inlined into
 * `ReportsService.create`, for the reason that event's contract already
 * states: reacting to it must never fail the filing that produced it. A
 * notification failure here is logged and swallowed, and the member who filed
 * still gets their confirmation.
 *
 * Two fan-outs, in this order:
 *
 *  1. PLATFORM STAFF: every active `users.role` of `moderator` or `admin`.
 *     This is the SLA-bearing channel and it fires for every report, whatever
 *     the subject.
 *  2. COMMUNITY STAFF: the owner, co-owners and mods of the community a
 *     reported post, reply or gathering photograph belongs to (or of a
 *     reported community itself). Anyone already reached by the platform
 *     fan-out is dropped from this one, so a moderator who also runs a
 *     community is told once, on the channel that carries the SLA.
 *
 * Three people are never notified, whatever role they hold: the member who
 * filed the report (nobody needs paging about their own filing), the member
 * the report is about, and anyone a fan-out already reached. The reporter is
 * also never NAMED: no notification here carries an actor id, so the bell
 * reads as the platform speaking whether or not the report was filed
 * anonymously, and no block or mute between a reporter and a moderator can
 * suppress duty mail.
 */
@Injectable()
export class ReportNotificationsListener {
  private readonly logger = new Logger(ReportNotificationsListener.name);

  constructor(
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    // TS-13: a reported gathering photograph resolves to its community and to
    // its uploader through the album's gathering. Read through the shared
    // `DataSource` rather than through two more injected repositories, for the
    // reason `ReportSubjectResolverService` gives for the same join: it is a
    // scoped, read-only, parameterized lookup that adds no entity registration
    // and no edge to the module graph. `Event` is imported under the name
    // `Gathering` because `event` is already bound to a `ReportCreatedEvent`
    // throughout this class, and two different things called "event" in one
    // resolver is how the wrong row gets read.
    private readonly dataSource: DataSource,
    private readonly membership: CommunityMembershipService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(REPORT_CREATED)
  async onReportCreated(event: ReportCreatedEvent): Promise<void> {
    try {
      await this.notifyResponders(event);
    } catch (error) {
      // Best-effort by the event's contract: a notification failure must never
      // surface to the reporter or fail the filing that produced this event.
      this.logger.warn(
        `report notification fan-out failed for report ${event.reportId}: ${String(error)}`,
      );
    }
  }

  private async notifyResponders(event: ReportCreatedEvent): Promise<void> {
    const report = await this.reports.findOne({
      where: { id: event.reportId },
    });
    if (!report) return;

    // One lookup, read once and handed to both resolvers below: a photo report
    // needs the uploader (to leave out of the fan-out) and the gathering's
    // community (to fan out TO), and both live on the same row. Resolving it
    // twice would be two round trips for one photograph, and on the emergency
    // band this listener exists for that is the wrong way round.
    const photoSubject =
      event.subjectType === ReportSubjectType.EventPhoto
        ? await this.resolvePhotoSubject(event.subjectId)
        : null;

    const excludedUserIds = new Set<string>();
    if (report.reporterId) excludedUserIds.add(report.reporterId);
    const reportedUserId = await this.resolveReportedUserId(
      event,
      photoSubject,
    );
    if (reportedUserId) excludedUserIds.add(reportedUserId);

    const sharedPayload = {
      reportId: report.id,
      severity: report.severity,
      reasonCode: report.reasonCode,
      subjectType: report.subjectType,
    };

    const notifiedUserIds = await this.notifyPlatformStaff(
      excludedUserIds,
      sharedPayload,
    );
    for (const userId of notifiedUserIds) excludedUserIds.add(userId);

    await this.notifyCommunityStaff(
      event,
      photoSubject,
      excludedUserIds,
      sharedPayload,
    );
  }

  /**
   * The platform's own responders. `createForRecipients` is called with no
   * actor argument on purpose: this is duty mail and must not be filtered by a
   * block or mute between the reporter and whoever is on shift. Returns the
   * recipients a row was actually written for, so the community fan-out below
   * can skip them.
   */
  private async notifyPlatformStaff(
    excludedUserIds: Set<string>,
    sharedPayload: Record<string, unknown>,
  ): Promise<string[]> {
    const staff = await this.users.find({
      where: {
        role: In([UserRole.Moderator, UserRole.Admin]),
        status: UserStatus.Active,
      },
      select: { id: true },
    });
    const recipientIds = staff
      .map((staffUser) => staffUser.id)
      .filter((userId) => !excludedUserIds.has(userId));
    if (!recipientIds.length) return [];
    return this.notifications.createForRecipients(
      recipientIds,
      NotificationType.ReportFiled,
      sharedPayload,
    );
  }

  /**
   * The community's own responders, when the report is attributable to one.
   * They see the same report from the mod-tools side, where the actions
   * available to them live, so the payload carries the community's slug and
   * name for the deep link and the copy.
   */
  private async notifyCommunityStaff(
    event: ReportCreatedEvent,
    photoSubject: EventPhotoSubject | null,
    excludedUserIds: Set<string>,
    sharedPayload: Record<string, unknown>,
  ): Promise<void> {
    const community = await this.resolveCommunity(event, photoSubject);
    if (!community) return; // report is not attributable to a community
    if (community.archivedAt) return; // nobody is running it any more

    const roster = await this.communityMembers.find({
      where: {
        communityId: community.id,
        role: In([...COMMUNITY_STAFF_ROLES]),
      },
      select: { userId: true },
    });
    const recipientIds = [
      ...new Set(
        [community.ownerId, ...roster.map((row) => row.userId)].filter(
          (userId): userId is string => !!userId,
        ),
      ),
    ].filter((userId) => !excludedUserIds.has(userId));
    if (!recipientIds.length) return;

    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.CommunityReportFiled,
      {
        ...sharedPayload,
        communitySlug: community.slug,
        communityName: community.name,
      },
    );
  }

  /**
   * The community a report belongs to, or `null` when it is not
   * community-scoped (a member, message or venue subject, or a flat forum post
   * that belongs to no community). Post and reply subjects resolve through
   * `CommunityMembershipService`, which already owns that mapping and its own
   * uuid guard.
   *
   * The four arms here are the four `CommunityAutoFreezeService
   * .resolveCommunity` and `ModerationService.communityIdForReportSubject`
   * answer for, and they have to keep agreeing: those decide which community
   * may ACT on a report and which community a report can freeze, and telling a
   * room about a report it cannot act on (or worse, staying silent about one
   * it can) is the same drift read from either end.
   *
   * TS-13: an `event_photo` resolves through the gathering whose album it is
   * in, so the community is the GATHERING's own (`events.community_id`) and is
   * never inferred from the uploader's memberships. A gathering that belongs
   * to no community notifies no community staff and the report stays
   * platform-only, which is the same answer the other two resolvers give.
   */
  private async resolveCommunity(
    event: ReportCreatedEvent,
    photoSubject: EventPhotoSubject | null,
  ): Promise<Community | null> {
    if (event.subjectType === ReportSubjectType.Community) {
      return this.communities.findOne({ where: { slug: event.subjectId } });
    }
    if (event.subjectType === ReportSubjectType.EventPhoto) {
      if (!photoSubject?.communityId) return null;
      return this.communities.findOne({
        where: { id: photoSubject.communityId },
      });
    }
    const communityId =
      event.subjectType === ReportSubjectType.Post
        ? await this.membership.communityIdForPost(event.subjectId)
        : event.subjectType === ReportSubjectType.Reply
          ? await this.membership.communityIdForReply(event.subjectId)
          : null;
    if (!communityId) return null;
    return this.communities.findOne({ where: { id: communityId } });
  }

  /**
   * One reported photograph read once: the community that hosts the gathering
   * its album belongs to, and the member who attached it.
   *
   * `LEFT JOIN` on the gathering, because a photo whose gathering row is gone
   * still has an uploader worth leaving out of the fan-out. `uploader_id` is
   * nullable (`ON DELETE SET NULL` since
   * `AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`), so an
   * erased uploader reads as `null` rather than crashing the fan-out, and it
   * NEVER falls back to the gathering's `host_id`: the host is a different
   * person from the uploader on most albums, and excluding them would silence
   * the one person most likely to be on duty for the room.
   *
   * A non-uuid `subjectId` is dropped before it reaches the `uuid` column, the
   * same guard every other resolver of a report subject keeps: `subjectId` is
   * only ever validated as a 1-200 character string, so a member can file a
   * report whose subject id would 500 a uuid-typed lookup.
   */
  private async resolvePhotoSubject(
    photoId: string,
  ): Promise<EventPhotoSubject | null> {
    if (!UUID_RE.test(photoId)) return null;
    const photoRow = await this.dataSource
      .createQueryBuilder(EventPhoto, 'photo')
      .leftJoin(Gathering, 'gathering', 'gathering.id = photo.event_id')
      .select('photo.uploader_id', 'uploaderId')
      .addSelect('gathering.community_id', 'communityId')
      .where('photo.id = :photoId', { photoId })
      .getRawOne<{ uploaderId: string | null; communityId: string | null }>();
    if (!photoRow) return null;
    return {
      communityId: photoRow.communityId ?? null,
      uploaderId: photoRow.uploaderId ?? null,
    };
  }

  /**
   * The member a report is about, so they are never told about it even when
   * they hold a staff role. Resolvable for the four subject types that name a
   * member: a post or reply through its author, a gathering photograph through
   * its uploader (TS-13, the only member `event_photos` records: nothing on
   * that row says who is depicted), and a member subject through its
   * `subjectId`, which is addressed by slug or by user id exactly as
   * `ModerationService.resolveReportedProfiles` reads it. Every other subject
   * type (a venue, a listing, a message) yields `null`, which only means there
   * is nobody to exclude on that axis.
   *
   * An erased uploader yields `null` on the same terms: there is no account
   * left to leave out, and the fan-out proceeds rather than failing.
   */
  private async resolveReportedUserId(
    event: ReportCreatedEvent,
    photoSubject: EventPhotoSubject | null,
  ): Promise<string | null> {
    if (event.subjectType === ReportSubjectType.EventPhoto) {
      return photoSubject?.uploaderId ?? null;
    }
    if (event.subjectType === ReportSubjectType.Post) {
      return this.membership.authorIdForPost(event.subjectId);
    }
    if (event.subjectType === ReportSubjectType.Reply) {
      return this.membership.authorIdForReply(event.subjectId);
    }
    if (event.subjectType !== ReportSubjectType.Member) return null;
    const profile = await this.profiles.findOne({
      where: UUID_RE.test(event.subjectId)
        ? [{ slug: event.subjectId }, { userId: event.subjectId }]
        : { slug: event.subjectId },
      select: { userId: true },
    });
    return profile?.userId ?? null;
  }
}
