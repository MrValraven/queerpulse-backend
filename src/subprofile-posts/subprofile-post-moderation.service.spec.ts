import { Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { SubprofilePostModerationService } from './subprofile-post-moderation.service';
import { PERSONA_POST_NOTIFICATIONS_DELETE_SQL } from './subprofile-posts.service';

const STAFF_ID = 'e1000000-0000-4000-8000-000000000001';
const POST_ID = 'e1000000-0000-4000-8000-000000000002';
const REPORT_ID = 'e1000000-0000-4000-8000-000000000005';
const IMAGE_KEY =
  'persona/e1000000-0000-4000-8000-000000000003/e1000000-0000-4000-8000-000000000004.jpg';

describe('SubprofilePostModerationService', () => {
  let storedPost: Partial<SubprofilePost> | null;
  let storedReport: Partial<Report> | null;
  let manager: { findOne: jest.Mock; delete: jest.Mock };
  let posts: { findOne: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let personaImageKeys: {
    forgetDeletedKeys: jest.Mock;
    deleteObjects: jest.Mock;
  };
  let dataSourceQuery: jest.Mock;
  let service: SubprofilePostModerationService;

  beforeAll(() => setImageUrlBase('https://api.test'));
  afterAll(() => resetImageUrlBaseForTesting());

  beforeEach(() => {
    storedPost = {
      id: POST_ID,
      subprofileId: 'persona-1',
      authorUserId: 'member-1',
      body: 'Something to remove',
      linkUrl: null,
      imageKey: IMAGE_KEY,
      createdAt: new Date('2026-10-13T09:00:00.000Z'),
      editedAt: null,
      subprofile: {
        id: 'persona-1',
        displayName: 'Night Shift',
        handle: 'night-shift',
        userId: 'member-1',
      } as SubprofilePost['subprofile'],
    };
    storedReport = {
      id: REPORT_ID,
      subjectType: ReportSubjectType.PersonaPost,
      subjectId: POST_ID,
    };
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(entity === Report ? storedReport : storedPost),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    posts = { findOne: jest.fn(() => Promise.resolve(storedPost)) };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    personaImageKeys = {
      forgetDeletedKeys: jest.fn().mockResolvedValue(undefined),
      deleteObjects: jest.fn().mockResolvedValue(undefined),
    };
    dataSourceQuery = jest.fn().mockResolvedValue([]);
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      query: dataSourceQuery,
    };
    service = new SubprofilePostModerationService(
      dataSource as unknown as DataSource,
      posts as unknown as Repository<SubprofilePost>,
      modAudit as unknown as ModAuditService,
      personaImageKeys as unknown as PersonaImageKeysService,
    );
  });

  it('shows staff the post, its photo and its persona, and no member id', async () => {
    const adminPost = await service.getForStaff(POST_ID);
    expect(adminPost).toEqual({
      id: POST_ID,
      body: 'Something to remove',
      linkUrl: null,
      imageUrl: `https://api.test/files/${IMAGE_KEY}`,
      createdAt: '2026-10-13T09:00:00.000Z',
      editedAt: null,
      persona: { id: 'persona-1', name: 'Night Shift', handle: 'night-shift' },
    });
    expect(JSON.stringify(adminPost)).not.toContain('member-1');
  });

  it('answers 404 for an unknown post', async () => {
    storedPost = null;
    await expect(service.getForStaff(POST_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes the post with an audit row in the same transaction, then its photo', async () => {
    await service.removePost(STAFF_ID, POST_ID, 'Harassment');

    expect(manager.delete).toHaveBeenCalledWith(SubprofilePost, {
      id: POST_ID,
    });
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'persona_post_removed',
      undefined,
      `${POST_ID}: Harassment`,
      undefined,
      manager,
      null,
    );
    expect(personaImageKeys.deleteObjects).toHaveBeenCalledWith([IMAGE_KEY]);
    expect(manager.delete.mock.invocationCallOrder[0]).toBeLessThan(
      personaImageKeys.deleteObjects.mock.invocationCallOrder[0]!,
    );
  });

  it('links the audit row to the report the removal answers', async () => {
    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment', REPORT_ID),
    ).resolves.toBeUndefined();

    expect(manager.findOne).toHaveBeenCalledWith(Report, {
      where: { id: REPORT_ID },
    });
    expect(manager.delete).toHaveBeenCalledWith(SubprofilePost, {
      id: POST_ID,
    });
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      REPORT_ID,
      STAFF_ID,
      'persona_post_removed',
      undefined,
      `${POST_ID}: Harassment`,
      undefined,
      manager,
      null,
    );
  });

  it('accepts a report that holds the post id in upper case', async () => {
    storedReport = { ...storedReport, subjectId: POST_ID.toUpperCase() };

    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment', REPORT_ID),
    ).resolves.toBeUndefined();
    expect(manager.delete).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for an unknown report id and writes nothing', async () => {
    storedReport = null;

    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment', REPORT_ID),
    ).rejects.toEqual(new NotFoundException('Report not found'));
    expect(manager.delete).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    expect(dataSourceQuery).not.toHaveBeenCalled();
    expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
  });

  it('answers 404 for a report about another post and writes nothing', async () => {
    storedReport = {
      ...storedReport,
      subjectId: 'e1000000-0000-4000-8000-0000000000ff',
    };

    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment', REPORT_ID),
    ).rejects.toEqual(new NotFoundException('Report not found'));
    expect(manager.delete).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('answers 404 for a report about another subject type and writes nothing', async () => {
    storedReport = {
      ...storedReport,
      subjectType: ReportSubjectType.StudioRelease,
    };

    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment', REPORT_ID),
    ).rejects.toEqual(new NotFoundException('Report not found'));
    expect(manager.delete).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('looks up no report when the removal names none', async () => {
    await service.removePost(STAFF_ID, POST_ID, 'Harassment');

    expect(manager.findOne).not.toHaveBeenCalledWith(Report, expect.anything());
  });

  it('deletes the follower bells of the removed post after the commit', async () => {
    await service.removePost(STAFF_ID, POST_ID, 'Harassment');

    expect(dataSourceQuery).toHaveBeenCalledWith(
      PERSONA_POST_NOTIFICATIONS_DELETE_SQL,
      [POST_ID],
    );
    expect(PERSONA_POST_NOTIFICATIONS_DELETE_SQL).toBe(
      `DELETE FROM "notifications" WHERE "type" = 'persona_post' AND "payload" ->> 'postId' = $1`,
    );
    expect(manager.delete.mock.invocationCallOrder[0]).toBeLessThan(
      dataSourceQuery.mock.invocationCallOrder[0]!,
    );
  });

  it('still removes the post when its bells cannot be deleted, and logs it', async () => {
    dataSourceQuery.mockRejectedValue(new Error('connection reset'));
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment'),
    ).resolves.toBeUndefined();

    expect(manager.delete).toHaveBeenCalledTimes(1);
    expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(POST_ID));
    expect(personaImageKeys.deleteObjects).toHaveBeenCalledWith([IMAGE_KEY]);
    warnSpy.mockRestore();
  });

  it('removes a post with no photo and touches no storage', async () => {
    storedPost = { ...storedPost, imageKey: null };

    await service.removePost(STAFF_ID, POST_ID, 'Harassment');

    expect(manager.delete).toHaveBeenCalledTimes(1);
    expect(personaImageKeys.forgetDeletedKeys).not.toHaveBeenCalled();
    expect(personaImageKeys.deleteObjects).not.toHaveBeenCalled();
  });

  it('still succeeds when the photo cannot be deleted, and logs it', async () => {
    personaImageKeys.deleteObjects.mockRejectedValue(new Error('bucket down'));
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.removePost(STAFF_ID, POST_ID, 'Harassment'),
    ).resolves.toBeUndefined();

    expect(manager.delete).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(IMAGE_KEY));
    warnSpy.mockRestore();
  });
});
