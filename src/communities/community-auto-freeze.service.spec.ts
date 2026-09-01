import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Report,
  ReportSeverity,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ReportCreatedEvent } from '../reports/report.events';
import { Event as Gathering } from '../events/entities/event.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { CommunityAutoFreezeService } from './community-auto-freeze.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community, CommunityFrozenReason } from './entities/community.entity';

// The conditional `UPDATE communities SET frozen_at = now() WHERE frozen_at IS
// NULL` chain (`.createQueryBuilder().update().set().where().execute()`).
// `affected: 1` by default: this freeze won the race.
const updateQbStub = (affected = 1) => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'where']) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.execute = jest.fn().mockResolvedValue({ affected });
  return queryBuilder;
};

// The scope-predicate builder behind `openReportCount` /
// `distinctOpenReporterCount`. `where`/`andWhere`/`select` chain; the terminals
// answer "no open reports" unless a test says otherwise.
const scopedQbStub = () => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere', 'select']) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getCount = jest.fn().mockResolvedValue(0);
  queryBuilder.getRawOne = jest.fn().mockResolvedValue({ count: '0' });
  return queryBuilder;
};

const COMMUNITY = {
  id: 'c1',
  slug: 'queer-devs',
  autoFreezeOnReports: true,
  frozenAt: null,
  archivedAt: null,
  ownerId: 'owner-1',
} as unknown as Community;

const PHOTO_REPORT: ReportCreatedEvent = {
  reportId: 'rep-1',
  subjectType: ReportSubjectType.EventPhoto,
  subjectId: '11111111-1111-4111-8111-111111111111',
  severity: ReportSeverity.Emergency,
  reasonCode: 'outing',
};

describe('CommunityAutoFreezeService', () => {
  let service: CommunityAutoFreezeService;
  let communities: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let posts: { findOne: jest.Mock };
  let replies: { findOne: jest.Mock };
  let eventPhotos: { findOne: jest.Mock };
  let gatherings: { findOne: jest.Mock };
  let reports: { createQueryBuilder: jest.Mock };
  let members: { find: jest.Mock };
  let governanceLog: { log: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let updateQueryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    updateQueryBuilder = updateQbStub();
    communities = {
      findOne: jest.fn().mockResolvedValue(COMMUNITY),
      createQueryBuilder: jest.fn(() => updateQueryBuilder),
    };
    posts = { findOne: jest.fn().mockResolvedValue(null) };
    replies = { findOne: jest.fn().mockResolvedValue(null) };
    eventPhotos = { findOne: jest.fn().mockResolvedValue(null) };
    gatherings = { findOne: jest.fn().mockResolvedValue(null) };
    reports = { createQueryBuilder: jest.fn(() => scopedQbStub()) };
    members = { find: jest.fn().mockResolvedValue([]) };
    governanceLog = { log: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityAutoFreezeService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityPost), useValue: posts },
        { provide: getRepositoryToken(CommunityPostReply), useValue: replies },
        { provide: getRepositoryToken(EventPhoto), useValue: eventPhotos },
        { provide: getRepositoryToken(Gathering), useValue: gatherings },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        {
          provide: CommunityGovernanceLogService,
          useValue: governanceLog,
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(CommunityAutoFreezeService);
  });

  // TS-13. `outing` and `doxxing` are the two `EMERGENCY_REASONS` codes, they
  // are why a single photograph became reportable at all, and `maybeFreeze`
  // deliberately lets ONE emergency report stop a community. Before this arm
  // existed, the subject type built for the emergency band was the one the
  // emergency trigger could not see.
  describe('an emergency photo report', () => {
    it("freezes the community hosting the photo's gathering", async () => {
      eventPhotos.findOne.mockResolvedValue({ eventId: 'ev-1' });
      gatherings.findOne.mockResolvedValue({ communityId: 'c1' });

      await service.onReportCreated(PHOTO_REPORT);

      expect(communities.findOne).toHaveBeenCalledWith({
        where: { id: 'c1' },
      });
      expect(updateQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          frozenReason: CommunityFrozenReason.EmergencyReport,
        }),
      );
      expect(updateQueryBuilder.execute).toHaveBeenCalled();
    });

    it('freezes on its own, with no pile-up and no second reporter', async () => {
      eventPhotos.findOne.mockResolvedValue({ eventId: 'ev-1' });
      gatherings.findOne.mockResolvedValue({ communityId: 'c1' });

      await service.onReportCreated(PHOTO_REPORT);

      // The pile-up counts are never consulted for an emergency: the `||`
      // short-circuits before `isReportPileUp` runs.
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
      expect(updateQueryBuilder.execute).toHaveBeenCalled();
    });

    it('freezes nothing when the gathering belongs to no community', async () => {
      eventPhotos.findOne.mockResolvedValue({ eventId: 'ev-1' });
      gatherings.findOne.mockResolvedValue({ communityId: null });

      await service.onReportCreated(PHOTO_REPORT);

      expect(updateQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it('freezes nothing when the photo row is gone', async () => {
      eventPhotos.findOne.mockResolvedValue(null);

      await service.onReportCreated(PHOTO_REPORT);

      expect(gatherings.findOne).not.toHaveBeenCalled();
      expect(updateQueryBuilder.execute).not.toHaveBeenCalled();
    });

    // `reports.subject_id` is a varchar that carries slugs and the
    // `"unspecified"` sentinel too, so a non-uuid value must never reach a
    // uuid-typed lookup.
    it('never lets a non-uuid subject id reach the photo lookup', async () => {
      await service.onReportCreated({
        ...PHOTO_REPORT,
        subjectId: 'not-a-uuid',
      });

      expect(eventPhotos.findOne).not.toHaveBeenCalled();
      expect(updateQueryBuilder.execute).not.toHaveBeenCalled();
    });

    it('respects a community that has auto-freeze switched off', async () => {
      eventPhotos.findOne.mockResolvedValue({ eventId: 'ev-1' });
      gatherings.findOne.mockResolvedValue({ communityId: 'c1' });
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        autoFreezeOnReports: false,
      });

      await service.onReportCreated(PHOTO_REPORT);

      expect(updateQueryBuilder.execute).not.toHaveBeenCalled();
    });
  });

  // `CommunitiesService.unfreeze` gates lifting an AUTOMATIC freeze on this
  // exact count, so a photo report that can freeze a community and cannot be
  // counted against it would be a freeze the owner could lift the same second.
  describe('openReportCount', () => {
    it("counts open photo reports against the community's own gatherings", async () => {
      const queryBuilder = scopedQbStub();
      queryBuilder.getCount!.mockResolvedValue(3);
      reports.createQueryBuilder.mockReturnValue(queryBuilder);

      await expect(service.openReportCount(COMMUNITY)).resolves.toBe(3);

      // The photo arm is one `orWhere` inside the single `Brackets` group, so
      // the predicate text is asserted through the bracket callback the
      // builder was handed.
      const andWhereCalls = queryBuilder.andWhere!.mock.calls as unknown as {
        whereFactory: (where: Record<string, jest.Mock>) => void;
      }[][];
      const bracket = andWhereCalls[0]![0]!;
      const where: Record<string, jest.Mock> = {};
      const calls: [string, Record<string, unknown>][] = [];
      where.where = jest.fn((sql: string, params: Record<string, unknown>) => {
        calls.push([sql, params]);
        return where;
      });
      where.orWhere = where.where;
      bracket.whereFactory(where);

      const photoArm = calls.find(([sql]) => sql.includes('event_photos'));
      expect(photoArm).toBeDefined();
      expect(photoArm?.[0]).toContain(
        '"__scoped_photo_event"."community_id" = :communityId',
      );
      expect(photoArm?.[1].eventPhotoType).toBe(ReportSubjectType.EventPhoto);
      expect(photoArm?.[1].communityId).toBe('c1');
    });
  });
});
