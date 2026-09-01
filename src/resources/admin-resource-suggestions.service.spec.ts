import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { Profile } from '../users/entities/profile.entity';
import { ResourceListingCategory } from './entities/resource-listing.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';
import { AdminResourceSuggestionsService } from './admin-resource-suggestions.service';

function makeSuggestion(
  overrides: Partial<ResourceSuggestion> = {},
): ResourceSuggestion {
  return {
    id: 'rs-1',
    memberId: 'member-1',
    category: ResourceListingCategory.SexualHealthTesting,
    name: 'Trans-friendly testing van (Almada)',
    description: 'Free anonymous rapid testing every Thursday evening.',
    phone: null,
    email: null,
    website: null,
    status: ResourceSuggestionStatus.Pending,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdAt: new Date('2026-08-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AdminResourceSuggestionsService', () => {
  let service: AdminResourceSuggestionsService;
  let suggestions: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let submissionDecisions: { notifyDecided: jest.Mock };

  const qbStub = (rows: ResourceSuggestion[]) => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['orderBy', 'skip', 'take', 'andWhere']) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([rows, rows.length]);
    return qb;
  };

  beforeEach(async () => {
    suggestions = {
      createQueryBuilder: jest.fn(() => qbStub([makeSuggestion()])),
      findOne: jest.fn(),
      save: jest.fn((v: Partial<ResourceSuggestion>) =>
        Promise.resolve({ ...makeSuggestion(), ...v }),
      ),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    submissionDecisions = {
      notifyDecided: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminResourceSuggestionsService,
        {
          provide: getRepositoryToken(ResourceSuggestion),
          useValue: suggestions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: SubmissionDecisionNotifier,
          useValue: submissionDecisions,
        },
      ],
    }).compile();
    service = module.get(AdminResourceSuggestionsService);
  });

  it('lists suggestions newest-first, paginated', async () => {
    const result = await service.list({});
    expect(result.total).toBe(1);
    expect(result.items[0]!.name).toBe('Trans-friendly testing van (Almada)');
  });

  it('approve() stamps status/decidedAt/decidedBy and trims the note', async () => {
    suggestions.findOne.mockResolvedValue(makeSuggestion());
    const result = await service.approve('rs-1', 'admin-1', '  looks great  ');

    expect(suggestions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResourceSuggestionStatus.Approved,
        decidedBy: 'admin-1',
        decisionNote: 'looks great',
      }),
    );
    expect(result.status).toBe(ResourceSuggestionStatus.Approved);
  });

  it('404s deciding a suggestion that does not exist', async () => {
    suggestions.findOne.mockResolvedValue(null);
    await expect(service.decline('missing', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('approving a suggestion cannot create a ResourceListing — the service has no dependency on that repository', async () => {
    // This testing module deliberately provides NO `Repository<ResourceListing>`.
    // If `AdminResourceSuggestionsService` (or a future change to it) ever tried
    // to inject or write through one, `Test.createTestingModule(...).compile()`
    // would throw `UnknownDependenciesException` before this assertion ever ran.
    suggestions.findOne.mockResolvedValue(makeSuggestion());
    const result = await service.approve('rs-1', 'admin-1');

    expect(result.status).toBe(ResourceSuggestionStatus.Approved);
    expect(result).not.toHaveProperty('listingId');
    expect(result).not.toHaveProperty('resourceListingId');
  });

  describe('telling the member what was decided (PRD-45)', () => {
    it('approving writes one accepted decision notification carrying the name and the note', async () => {
      suggestions.findOne.mockResolvedValue(makeSuggestion());

      await service.approve('rs-1', 'admin-1', '  Added to the directory.  ');

      expect(submissionDecisions.notifyDecided).toHaveBeenCalledTimes(1);
      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith({
        recipientId: 'member-1',
        kind: SubmissionKind.ResourceSuggestion,
        outcome: SubmissionOutcome.Accepted,
        subjectLabel: 'Trans-friendly testing van (Almada)',
        reviewNote: 'Added to the directory.',
      });
    });

    it('declining writes a declined outcome, never an archived one', async () => {
      suggestions.findOne.mockResolvedValue(makeSuggestion());

      await service.decline('rs-1', 'admin-1', 'They closed in 2019.');

      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: SubmissionOutcome.Declined,
          reviewNote: 'They closed in 2019.',
        }),
      );
    });

    it('never names the admin who decided: the notice has no actor field to put them in', async () => {
      suggestions.findOne.mockResolvedValue(makeSuggestion());

      await service.decline('rs-1', 'admin-1', 'Outside Lisbon.');

      const [notice] = submissionDecisions.notifyDecided.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(JSON.stringify(notice)).not.toContain('admin-1');
    });

    it('archiving stays silent: it tidies the queue, it does not decide anything', async () => {
      // Deliberate, and the same position `AdminReadingGroupProposalsService.archive`
      // takes. A row whose only content is that nobody decided is noise, and
      // the member still sees the true state on
      // `GET /resources/suggestions/mine`.
      suggestions.findOne.mockResolvedValue(makeSuggestion());

      const result = await service.archive('rs-1', 'admin-1', 'Duplicate.');

      expect(result.status).toBe(ResourceSuggestionStatus.Archived);
      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('re-deciding the same way does not notify a second time', async () => {
      suggestions.findOne.mockResolvedValue(
        makeSuggestion({
          status: ResourceSuggestionStatus.Approved,
          decidedAt: new Date('2026-08-20T00:00:00.000Z'),
          decidedBy: 'admin-1',
        }),
      );

      // Restamping the note on an already-approved row is a legitimate
      // correction. It is not news, and it must not put a second identical
      // row in the member's bell.
      await service.approve('rs-1', 'admin-2', 'Corrected wording.');

      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('writes nothing when the row carries no submitter id', async () => {
      suggestions.findOne.mockResolvedValue(makeSuggestion({ memberId: '' }));

      await service.approve('rs-1', 'admin-1');

      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('a failing notifier never fails the decision it was reporting', async () => {
      suggestions.findOne.mockResolvedValue(makeSuggestion());
      submissionDecisions.notifyDecided.mockRejectedValue(
        new Error('bell unavailable'),
      );

      // The decision has already committed by this point. An admin who saw a
      // 500 here would reasonably retry, onto an already-decided row.
      const result = await service.approve('rs-1', 'admin-1');

      expect(result.status).toBe(ResourceSuggestionStatus.Approved);
    });
  });
});
