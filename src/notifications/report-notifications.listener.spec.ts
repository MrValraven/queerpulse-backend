import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Event as Gathering } from '../events/entities/event.entity';
import {
  Report,
  ReportSeverity,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ReportCreatedEvent } from '../reports/report.events';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { NotificationType } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';
import { ReportNotificationsListener } from './report-notifications.listener';

// `event_photos.id` is a uuid column, so a subject id meant to actually
// resolve has to be UUID-shaped — the same constraint `UUID_RE` in the
// listener enforces before anything reaches Postgres.
const REPORTED_PHOTO_ID = '44444444-4444-4444-4444-444444444444';

const COMMUNITY = {
  id: 'community-1',
  slug: 'circle-of-care',
  name: 'Circle of Care',
  ownerId: 'user-owner',
  archivedAt: null,
} as unknown as Community;

const PHOTO_REPORT_EVENT: ReportCreatedEvent = {
  reportId: 'report-1',
  subjectType: ReportSubjectType.EventPhoto,
  subjectId: REPORTED_PHOTO_ID,
  severity: ReportSeverity.Emergency,
  reasonCode: 'outing',
};

const PHOTO_REPORT = {
  id: 'report-1',
  subjectType: ReportSubjectType.EventPhoto,
  subjectId: REPORTED_PHOTO_ID,
  severity: ReportSeverity.Emergency,
  reasonCode: 'outing',
  reporterId: 'user-reporter',
} as unknown as Report;

/** The payload every fan-out in this file shares, before the community fields
 *  the community channel adds. */
const SHARED_PAYLOAD = {
  reportId: 'report-1',
  severity: ReportSeverity.Emergency,
  reasonCode: 'outing',
  subjectType: ReportSubjectType.EventPhoto,
};

type QueryBuilderStub = Record<string, jest.Mock>;

/**
 * Stubs the one raw lookup this listener runs: `event_photos` left-joined to
 * `events`, read off the shared `DataSource`. `rawRow` is what
 * `getRawOne` resolves to — `undefined` for a photo id that matches nothing.
 */
function makePhotoQueryBuilderStub(
  rawRow: { uploaderId: string | null; communityId: string | null } | undefined,
): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {};
  for (const chainedMethod of ['leftJoin', 'select', 'addSelect', 'where']) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawOne = jest.fn().mockResolvedValue(rawRow);
  return queryBuilder;
}

function makeRosterRow(
  userId: string,
  role: RosterRole = RosterRole.Mod,
): CommunityMember {
  return { userId, role } as unknown as CommunityMember;
}

describe('ReportNotificationsListener', () => {
  let listener: ReportNotificationsListener;
  let reports: { findOne: jest.Mock };
  let users: { find: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let communities: { findOne: jest.Mock };
  let communityMembers: { find: jest.Mock };
  let dataSource: { createQueryBuilder: jest.Mock };
  let membership: {
    communityIdForPost: jest.Mock;
    communityIdForReply: jest.Mock;
    authorIdForPost: jest.Mock;
    authorIdForReply: jest.Mock;
  };
  let notifications: { createForRecipients: jest.Mock };
  let photoQueryBuilder: QueryBuilderStub;

  /** Every `createForRecipients` call, as its three declared arguments. A
   *  FOURTH argument would be an actor id, which no fan-out here may pass. */
  type FanOutCall = [string[], NotificationType, Record<string, unknown>];
  function fanOutCalls(): FanOutCall[] {
    return notifications.createForRecipients.mock.calls as FanOutCall[];
  }

  /** The recipients of the one `CommunityReportFiled` fan-out, or `null` when
   *  no community notification was written at all. */
  function communityRecipients(): string[] | null {
    const call = fanOutCalls().find(
      ([, notificationType]) =>
        notificationType === NotificationType.CommunityReportFiled,
    );
    return call ? call[0] : null;
  }

  beforeEach(async () => {
    reports = { findOne: jest.fn().mockResolvedValue(PHOTO_REPORT) };
    // No platform staff by default, so the community fan-out under test is not
    // silently narrowed by the platform exclusion that runs before it.
    users = { find: jest.fn().mockResolvedValue([]) };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };
    communities = { findOne: jest.fn().mockResolvedValue(COMMUNITY) };
    communityMembers = { find: jest.fn().mockResolvedValue([]) };
    photoQueryBuilder = makePhotoQueryBuilderStub({
      uploaderId: 'user-uploader',
      communityId: 'community-1',
    });
    dataSource = {
      createQueryBuilder: jest.fn(() => photoQueryBuilder),
    };
    membership = {
      communityIdForPost: jest.fn().mockResolvedValue(null),
      communityIdForReply: jest.fn().mockResolvedValue(null),
      authorIdForPost: jest.fn().mockResolvedValue(null),
      authorIdForReply: jest.fn().mockResolvedValue(null),
    };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportNotificationsListener,
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Community), useValue: communities },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    listener = module.get(ReportNotificationsListener);
  });

  // TS-13. A single photograph became reportable because `outing` and
  // `doxxing` need answering inside the hour, and a photo report on a
  // community-hosted gathering now lands in that community's own queue. A
  // queue nobody is told about is a queue nobody reads.
  describe('a report on a gathering photograph', () => {
    it("tells the moderators of the community hosting the photo's gathering", async () => {
      communityMembers.find.mockResolvedValue([
        makeRosterRow('user-owner', RosterRole.Owner),
        makeRosterRow('user-mod'),
        makeRosterRow('user-co-owner', RosterRole.CoOwner),
      ]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      // The community comes off the GATHERING, never off the uploader's
      // memberships: one photo lookup, joined through `events`.
      expect(dataSource.createQueryBuilder).toHaveBeenCalledWith(
        EventPhoto,
        'photo',
      );
      expect(photoQueryBuilder.leftJoin).toHaveBeenCalledWith(
        Gathering,
        'gathering',
        'gathering.id = photo.event_id',
      );
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { id: 'community-1' },
      });
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['user-owner', 'user-mod', 'user-co-owner'],
        NotificationType.CommunityReportFiled,
        {
          ...SHARED_PAYLOAD,
          communitySlug: 'circle-of-care',
          communityName: 'Circle of Care',
        },
      );
    });

    it('resolves the photograph once and serves both the exclusion and the fan-out from it', async () => {
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      // The uploader (to leave out) and the gathering's community (to fan out
      // to) come off the same row, so one report is one round trip.
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('notifies nobody on the community channel when the gathering belongs to no community', async () => {
      photoQueryBuilder = makePhotoQueryBuilderStub({
        uploaderId: 'user-uploader',
        communityId: null,
      });
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      // No community is guessed at from the uploader's memberships: the
      // report stays platform-only.
      expect(communities.findOne).not.toHaveBeenCalled();
      expect(communityRecipients()).toBeNull();
    });

    it('notifies nobody on the community channel when the photograph is already gone', async () => {
      photoQueryBuilder = makePhotoQueryBuilderStub(undefined);
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      expect(communityRecipients()).toBeNull();
    });

    it('leaves the photograph out of the lookup entirely when its subject id is not a uuid', async () => {
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated({
        ...PHOTO_REPORT_EVENT,
        subjectId: 'x',
      });

      // `event_photos.id` is a uuid column and `subjectId` is only ever
      // validated as a 1-200 character string, so 'x' would 500 the lookup.
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
      expect(communityRecipients()).toBeNull();
    });

    it('excludes the uploader from the fan-out even when they run the community', async () => {
      communityMembers.find.mockResolvedValue([
        makeRosterRow('user-uploader'),
        makeRosterRow('user-mod'),
      ]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      // Nobody is told about a report that is about them. The uploader is the
      // only member `event_photos` records, so they are who a photo report
      // names.
      expect(communityRecipients()).toEqual(['user-owner', 'user-mod']);
    });

    it('also excludes the reporter, who is never a recipient of their own filing', async () => {
      communityMembers.find.mockResolvedValue([
        makeRosterRow('user-reporter'),
        makeRosterRow('user-mod'),
      ]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      expect(communityRecipients()).toEqual(['user-owner', 'user-mod']);
    });

    it('still fans out when the uploader has erased their account', async () => {
      // `event_photos.uploader_id` is `ON DELETE SET NULL`, so an erased
      // uploader reads as null. There is simply nobody to leave out, and the
      // moderators still have to be told.
      photoQueryBuilder = makePhotoQueryBuilderStub({
        uploaderId: null,
        communityId: 'community-1',
      });
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      expect(communityRecipients()).toEqual(['user-owner', 'user-mod']);
    });

    it('never falls back to the gathering host in place of a missing uploader', async () => {
      photoQueryBuilder = makePhotoQueryBuilderStub({
        uploaderId: null,
        communityId: 'community-1',
      });
      communityMembers.find.mockResolvedValue([makeRosterRow('user-host')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      // The host is a different person from the uploader on most albums, and
      // dropping them would silence somebody who did nothing but run the
      // event.
      expect(communityRecipients()).toContain('user-host');
    });

    it('says nothing to a community that has been archived', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        archivedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      expect(communityRecipients()).toBeNull();
    });

    it('never names the reporter on either channel', async () => {
      users.find.mockResolvedValue([{ id: 'user-staff' }]);
      notifications.createForRecipients.mockResolvedValue(['user-staff']);
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      // Duty mail. No call passes an actor id, so the bell reads as the
      // platform speaking whether or not the report was filed anonymously,
      // and no block or mute between a reporter and a moderator can suppress
      // it. No payload carries the reporter either.
      for (const call of fanOutCalls()) {
        expect(call).toHaveLength(3);
        expect(JSON.stringify(call[2])).not.toContain('user-reporter');
      }
      // The SLA-bearing channel is every ACTIVE moderator/admin account, and
      // it fires whatever the subject.
      const [staffQuery] = users.find.mock.calls[0] as [
        {
          where: { role: unknown; status: UserStatus };
          select: Record<string, boolean>;
        },
      ];
      expect(staffQuery.where.status).toBe(UserStatus.Active);
      expect(staffQuery.select).toEqual({ id: true });
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['user-staff'],
        NotificationType.ReportFiled,
        SHARED_PAYLOAD,
      );
    });

    it('tells a moderator who is also platform staff once, on the SLA channel', async () => {
      users.find.mockResolvedValue([{ id: 'user-mod' }]);
      notifications.createForRecipients.mockResolvedValue(['user-mod']);
      communityMembers.find.mockResolvedValue([makeRosterRow('user-mod')]);

      await listener.onReportCreated(PHOTO_REPORT_EVENT);

      expect(communityRecipients()).toEqual(['user-owner']);
    });

    it('swallows a lookup failure rather than failing the filing that produced it', async () => {
      photoQueryBuilder.getRawOne!.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(
        listener.onReportCreated(PHOTO_REPORT_EVENT),
      ).resolves.toBeUndefined();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });
  });

  // The photo arm must not have widened what any other subject type resolves
  // to: a post report still goes through `CommunityMembershipService`, which
  // owns that mapping.
  describe('the arms that were already here', () => {
    it('still resolves a post report through the membership service', async () => {
      const postReportEvent: ReportCreatedEvent = {
        reportId: 'report-2',
        subjectType: ReportSubjectType.Post,
        subjectId: '11111111-1111-1111-1111-111111111111',
        severity: ReportSeverity.High,
        reasonCode: 'harassment',
      };
      reports.findOne.mockResolvedValue({
        ...PHOTO_REPORT,
        id: 'report-2',
        subjectType: ReportSubjectType.Post,
        severity: ReportSeverity.High,
        reasonCode: 'harassment',
      });
      membership.communityIdForPost.mockResolvedValue('community-1');
      membership.authorIdForPost.mockResolvedValue('user-author');
      communityMembers.find.mockResolvedValue([
        makeRosterRow('user-author'),
        makeRosterRow('user-mod'),
      ]);

      await listener.onReportCreated(postReportEvent);

      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
      expect(membership.communityIdForPost).toHaveBeenCalledWith(
        '11111111-1111-1111-1111-111111111111',
      );
      // The post's author is the reported member, so they are left out.
      expect(communityRecipients()).toEqual(['user-owner', 'user-mod']);
    });
  });
});
