import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { Profile } from '../users/entities/profile.entity';
import { ApproveResourceSuggestionDto } from './dto/approve-resource-suggestion.dto';
import {
  ResourceListing,
  ResourceListingCategory,
  ResourceListingStatus,
} from './entities/resource-listing.entity';
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
    createdListingId: null,
    createdAt: new Date('2026-08-15T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * The listing body a reviewing admin confirms at approval time (PRD-269).
 *
 * Deliberately NOT a copy of the suggestion's own fields: the console
 * pre-fills the form from the suggestion and the admin corrects it, and the
 * two fields below that the suggestion cannot carry at all — a `region`, and
 * a phone number where the member gave none — are the reason approval takes a
 * body rather than inventing one.
 */
function makeApproveDto(
  overrides: Partial<ApproveResourceSuggestionDto> = {},
): ApproveResourceSuggestionDto {
  return {
    listing: {
      category: ResourceListingCategory.SexualHealthTesting,
      title: 'Trans-friendly testing van (Almada)',
      description: 'Free anonymous rapid testing every Thursday evening.',
      phone: '+351 210 000 000',
      region: 'Almada',
    },
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
  // The entity manager the approval transaction runs through. `findOne` is
  // the LOCKED read of the suggestion; `save` records both writes in order, so
  // a test can assert the listing was written before the status flipped and
  // that both went through the same manager.
  let transactionManager: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let savedInTransaction: unknown[];

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
    savedInTransaction = [];
    transactionManager = {
      findOne: jest.fn(),
      // Mirrors TypeORM: `create` hands back a plain entity-shaped object.
      create: jest.fn(
        (_entity: unknown, values: Record<string, unknown>) => values,
      ),
      save: jest.fn((value: Record<string, unknown>) => {
        // A created listing has no id until it is saved; the service reads
        // `createdListing.id` straight afterwards, so the stub has to supply
        // one the way the database would.
        const saved = value.id ? value : { ...value, id: 'listing-1' };
        savedInTransaction.push(saved);
        return Promise.resolve(saved);
      }),
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
        {
          provide: DataSource,
          useValue: {
            transaction: (
              run: (manager: typeof transactionManager) => Promise<unknown>,
            ) => run(transactionManager),
          },
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
    transactionManager.findOne.mockResolvedValue(makeSuggestion());
    const result = await service.approve(
      'rs-1',
      'admin-1',
      makeApproveDto({ note: '  looks great  ' }),
    );

    expect(transactionManager.save).toHaveBeenCalledWith(
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

  describe('approval publishes the listing (PRD-269)', () => {
    it('creates the directory listing from the REVIEWED body, not the member submission', async () => {
      // The member gave an email and no phone, and no region at all. The
      // reviewer supplied a phone number and a region and the listing carries
      // theirs: the suggestion is a lead, the listing is what was checked.
      transactionManager.findOne.mockResolvedValue(
        makeSuggestion({ email: 'testingvan@example.org', phone: null }),
      );

      await service.approve('rs-1', 'admin-1', makeApproveDto());

      expect(transactionManager.create).toHaveBeenCalledWith(
        ResourceListing,
        expect.objectContaining({
          category: ResourceListingCategory.SexualHealthTesting,
          phone: '+351 210 000 000',
          region: 'Almada',
          status: ResourceListingStatus.Active,
          createdBy: 'admin-1',
          updatedBy: 'admin-1',
        }),
      );
      // A field the reviewer left out is NULL, never the member's value
      // silently copied through.
      expect(transactionManager.create).toHaveBeenCalledWith(
        ResourceListing,
        expect.objectContaining({ email: null, website: null }),
      );
    });

    it('writes the listing and the status flip through the SAME manager, listing first', async () => {
      // Both writes go through the transaction's manager, so a failure on
      // either cannot leave a suggestion marked approved with nothing in the
      // directory — the exact state the old two-step flow produced.
      transactionManager.findOne.mockResolvedValue(makeSuggestion());

      await service.approve('rs-1', 'admin-1', makeApproveDto());

      expect(savedInTransaction).toHaveLength(2);
      expect(savedInTransaction[0]).toEqual(
        expect.objectContaining({ id: 'listing-1', title: expect.any(String) }),
      );
      expect(savedInTransaction[1]).toEqual(
        expect.objectContaining({
          status: ResourceSuggestionStatus.Approved,
          createdListingId: 'listing-1',
        }),
      );
      // The plain repository is never used for a decision that publishes.
      expect(suggestions.save).not.toHaveBeenCalled();
    });

    it('reads the suggestion under a write lock, so two approvals serialize', async () => {
      transactionManager.findOne.mockResolvedValue(makeSuggestion());

      await service.approve('rs-1', 'admin-1', makeApproveDto());

      expect(transactionManager.findOne).toHaveBeenCalledWith(
        ResourceSuggestion,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('409s a second approve on an already-approved suggestion', async () => {
      transactionManager.findOne.mockResolvedValue(
        makeSuggestion({
          status: ResourceSuggestionStatus.Approved,
          decidedAt: new Date('2026-08-20T00:00:00.000Z'),
        }),
      );

      await expect(
        service.approve('rs-1', 'admin-2', makeApproveDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(savedInTransaction).toHaveLength(0);
    });

    it('409s a row that already carries a listing, whatever its status says', async () => {
      // The stronger of the two guards: it catches a row whose status was
      // moved by some other path but which has already been published.
      transactionManager.findOne.mockResolvedValue(
        makeSuggestion({ createdListingId: 'listing-existing' }),
      );

      await expect(
        service.approve('rs-1', 'admin-1', makeApproveDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(savedInTransaction).toHaveLength(0);
    });

    it('404s approving a suggestion that does not exist', async () => {
      transactionManager.findOne.mockResolvedValue(null);

      await expect(
        service.approve('missing', 'admin-1', makeApproveDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to decline a published suggestion out from under its live listing', async () => {
      // Flipping this row to `declined` would leave the organisation live in
      // the public directory while the queue said it had been turned down.
      // Taking the listing down happens on Resource listings first.
      suggestions.findOne.mockResolvedValue(
        makeSuggestion({
          status: ResourceSuggestionStatus.Approved,
          createdListingId: 'listing-1',
        }),
      );

      await expect(
        service.decline('rs-1', 'admin-1', 'On second thoughts.'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(suggestions.save).not.toHaveBeenCalled();
    });
  });

  describe('telling the member what was decided (PRD-45)', () => {
    it('approving writes one accepted decision notification carrying the name, the note and the live directory page', async () => {
      transactionManager.findOne.mockResolvedValue(makeSuggestion());

      await service.approve(
        'rs-1',
        'admin-1',
        makeApproveDto({ note: '  Added to the directory.  ' }),
      );

      expect(submissionDecisions.notifyDecided).toHaveBeenCalledTimes(1);
      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith({
        recipientId: 'member-1',
        kind: SubmissionKind.ResourceSuggestion,
        outcome: SubmissionOutcome.Accepted,
        subjectLabel: 'Trans-friendly testing van (Almada)',
        reviewNote: 'Added to the directory.',
        // PRD-269: "accepted" now opens the public page the organisation is
        // actually on. The slug is the CATEGORY, because the directory has no
        // per-listing page.
        deepLinkSource: 'resource_directory',
        deepLinkSlug: ResourceListingCategory.SexualHealthTesting,
      });
    });

    it('a decline carries no directory deep link: there is nothing published to open', async () => {
      suggestions.findOne.mockResolvedValue(makeSuggestion());

      await service.decline('rs-1', 'admin-1', 'They closed in 2019.');

      const [notice] = submissionDecisions.notifyDecided.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(notice).not.toHaveProperty('deepLinkSource');
      expect(notice).not.toHaveProperty('deepLinkSlug');
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
          status: ResourceSuggestionStatus.Declined,
          decidedAt: new Date('2026-08-20T00:00:00.000Z'),
          decidedBy: 'admin-1',
        }),
      );

      // Restamping the note on an already-declined row is a legitimate
      // correction. It is not news, and it must not put a second identical
      // row in the member's bell. (Approve is no longer one of these cases:
      // it 409s instead, because a second approve would mean a second
      // listing.)
      await service.decline('rs-1', 'admin-2', 'Corrected wording.');

      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('writes nothing when the row carries no submitter id', async () => {
      transactionManager.findOne.mockResolvedValue(
        makeSuggestion({ memberId: '' }),
      );

      await service.approve('rs-1', 'admin-1', makeApproveDto());

      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('a failing notifier never fails the decision it was reporting', async () => {
      transactionManager.findOne.mockResolvedValue(makeSuggestion());
      submissionDecisions.notifyDecided.mockRejectedValue(
        new Error('bell unavailable'),
      );

      // The transaction has already committed by this point. An admin who saw
      // a 500 here would reasonably retry, onto a row that now 409s.
      const result = await service.approve(
        'rs-1',
        'admin-1',
        makeApproveDto(),
      );

      expect(result.status).toBe(ResourceSuggestionStatus.Approved);
    });
  });
});
