import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { AdminStorySubmissionsService } from './admin-story-submissions.service';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';

function makeSubmission(
  overrides: Partial<MagazineStorySubmission> = {},
): MagazineStorySubmission {
  return {
    id: 'sub-1',
    userId: 'user-1',
    format: 'Personal essay',
    workingTitle: 'The year the co-op nearly closed',
    pitch: 'Pitch text.',
    deck: null,
    body: 'The first paragraph.',
    coverImageKey: null,
    status: SubmissionStatus.Rejected,
    decision: 'declined',
    decisionNote: 'Not for this issue, please send us the next one.',
    decidedBy: 'editor-1',
    decidedAt: new Date('2026-07-12T00:00:00.000Z'),
    reopenedBy: null,
    reopenedAt: null,
    reopenCount: 0,
    withdrawnAt: null,
    commissionedPitchId: null,
    acceptedPieceId: null,
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A minimal `Repository` double: only the members `reopen` actually calls.
 * Cast once here, via `unknown`, so call sites never repeat their own `as any`
 * and the service still sees a precisely-typed `Repository`.
 */
function makeSubmissionsRepo(
  findOneResult: MagazineStorySubmission | null,
  updateAffected = 1,
): Repository<MagazineStorySubmission> & { update: jest.Mock } {
  return {
    findOne: jest.fn(async () => findOneResult),
    update: jest.fn(async () => ({ affected: updateAffected })),
  } as unknown as Repository<MagazineStorySubmission> & { update: jest.Mock };
}

function makePitchesRepo(): Repository<MagazinePitch> {
  return {} as unknown as Repository<MagazinePitch>;
}

function makeProfilesRepo(): Repository<Profile> {
  return {
    find: jest.fn(async () => []),
  } as unknown as Repository<Profile>;
}

function makeNotifications(
  create: jest.Mock = jest.fn(),
): NotificationsService {
  return { create } as unknown as NotificationsService;
}

function makeService(
  submissions: Repository<MagazineStorySubmission>,
  notifications: NotificationsService = makeNotifications(),
): AdminStorySubmissionsService {
  return new AdminStorySubmissionsService(
    submissions,
    makePitchesRepo(),
    makeProfilesRepo(),
    notifications,
  );
}

/**
 * `reopen` is the only route back from a decline. Everything asserted here is
 * about what it REFUSES: a yes left a record on the desk, a withdrawal was the
 * member's own decision, and an undecided row is already in the queue.
 */
describe('AdminStorySubmissionsService.reopen', () => {
  it('throws NotFoundException when the submission does not exist', async () => {
    const service = makeService(makeSubmissionsRepo(null));
    await expect(service.reopen('editor-2', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a story the member withdrew, before anything else', async () => {
    const submissions = makeSubmissionsRepo(
      makeSubmission({ withdrawnAt: new Date('2026-07-11T00:00:00.000Z') }),
    );
    const service = makeService(submissions);
    await expect(service.reopen('editor-2', 'sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submissions.update).not.toHaveBeenCalled();
  });

  it('refuses an undecided submission: it is already in the queue', async () => {
    const submissions = makeSubmissionsRepo(
      makeSubmission({
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedBy: null,
        decidedAt: null,
      }),
    );
    const service = makeService(submissions);
    await expect(service.reopen('editor-2', 'sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submissions.update).not.toHaveBeenCalled();
  });

  it('refuses an accepted submission, whose desk piece would be stranded', async () => {
    const submissions = makeSubmissionsRepo(
      makeSubmission({
        status: SubmissionStatus.Accepted,
        decision: 'accepted',
        acceptedPieceId: 'piece-1',
      }),
    );
    const service = makeService(submissions);
    await expect(service.reopen('editor-2', 'sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submissions.update).not.toHaveBeenCalled();
  });

  it('refuses a commissioned submission, whose pitch would be stranded', async () => {
    const submissions = makeSubmissionsRepo(
      makeSubmission({
        status: SubmissionStatus.Accepted,
        decision: 'commissioned',
        commissionedPitchId: 'pitch-1',
      }),
    );
    const service = makeService(submissions);
    await expect(service.reopen('editor-2', 'sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submissions.update).not.toHaveBeenCalled();
  });

  it('refuses a declined row that somehow carries a desk link', async () => {
    const submissions = makeSubmissionsRepo(
      makeSubmission({ acceptedPieceId: 'piece-1' }),
    );
    const service = makeService(submissions);
    await expect(service.reopen('editor-2', 'sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submissions.update).not.toHaveBeenCalled();
  });

  it('clears the decision, stamps the reopen, and returns the row to the queue', async () => {
    const submissions = makeSubmissionsRepo(makeSubmission());
    const create = jest.fn();
    const service = makeService(submissions, makeNotifications(create));

    const result = await service.reopen('editor-2', 'sub-1');

    // The claim is matched on the row still being declined with no desk link,
    // so a decision landing between the read and the write wins.
    const [criteria, patch] = submissions.update.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).toMatchObject({ id: 'sub-1', decision: 'declined' });
    expect(patch).toMatchObject({
      status: SubmissionStatus.Submitted,
      decision: null,
      decisionNote: null,
      decidedBy: null,
      decidedAt: null,
      reopenedBy: 'editor-2',
    });
    // Incremented in SQL, so two editors reopening at once cannot both write
    // the same number.
    expect(typeof patch.reopenCount).toBe('function');

    expect(result.status).toBe(SubmissionStatus.Submitted);
    expect(result.decision).toBeNull();
    expect(result.decisionNote).toBeNull();
    expect(result.decidedAt).toBeNull();
    expect(result.reopenCount).toBe(1);
    expect(result.reopenedAt).not.toBeNull();
  });

  it('tells the member their story is open again, and never by email', async () => {
    const submissions = makeSubmissionsRepo(makeSubmission());
    const create = jest.fn();
    const service = makeService(submissions, makeNotifications(create));

    await service.reopen('editor-2', 'sub-1');

    expect(create).toHaveBeenCalledWith(
      'user-1',
      NotificationType.StorySubmissionDecided,
      {
        decision: 'reopened',
        workingTitle: 'The year the co-op nearly closed',
      },
    );
  });

  it('keeps the reopen when the notification fails', async () => {
    const submissions = makeSubmissionsRepo(makeSubmission());
    const create = jest.fn(async () => {
      throw new Error('bell is down');
    });
    const service = makeService(submissions, makeNotifications(create));

    await expect(service.reopen('editor-2', 'sub-1')).resolves.toMatchObject({
      decision: null,
    });
  });

  it('answers 409 when the claim matches nothing, and rings nobody', async () => {
    const submissions = makeSubmissionsRepo(makeSubmission(), 0);
    const create = jest.fn();
    const service = makeService(submissions, makeNotifications(create));

    await expect(service.reopen('editor-2', 'sub-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
