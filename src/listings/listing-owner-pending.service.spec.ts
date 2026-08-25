import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { LISTING_DISPUTE_REASON_CODE } from './dto/dispute-listing.dto';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { Listing } from './entities/listing.entity';
import { ListingCoManagersService } from './listing-co-managers.service';
import {
  ListingOwnerPendingService,
  OWNER_PENDING_ITEM_CAP,
} from './listing-owner-pending.service';

type FindAndCountMock = { findAndCount: jest.Mock };

describe('ListingOwnerPendingService', () => {
  let service: ListingOwnerPendingService;
  let listings: { findOne: jest.Mock };
  let coManagers: { isActiveCoManager: jest.Mock };
  let suggestions: FindAndCountMock;
  let claims: FindAndCountMock;
  let questions: FindAndCountMock;
  let reports: FindAndCountMock;

  const OWNED_LISTING = {
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'lux-cafe',
    ownerId: 'owner-1',
  } as Listing;

  const emptyFindAndCount = (): FindAndCountMock => ({
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  });

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(OWNED_LISTING) };
    coManagers = { isActiveCoManager: jest.fn().mockResolvedValue(false) };
    suggestions = emptyFindAndCount();
    claims = emptyFindAndCount();
    questions = emptyFindAndCount();
    reports = emptyFindAndCount();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingOwnerPendingService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(ListingEditSuggestion),
          useValue: suggestions,
        },
        { provide: getRepositoryToken(ListingClaim), useValue: claims },
        { provide: getRepositoryToken(ListingQuestion), useValue: questions },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: ListingCoManagersService, useValue: coManagers },
      ],
    }).compile();
    service = module.get(ListingOwnerPendingService);
  });

  describe('management gate', () => {
    it('404s a caller who neither owns nor co-manages the ref, reading no queue at all', async () => {
      // The listing EXISTS and is loaded by ref alone; what the caller fails is
      // the ownership comparison and then the co-manager seat lookup. The 404
      // is therefore a deliberate refusal to confirm the ref, not a miss.
      await expect(
        service.getPendingForOwner('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(listings.findOne).toHaveBeenCalledWith({
        where: { ref: 'QPL-2026-0001' },
      });
      expect(coManagers.isActiveCoManager).toHaveBeenCalledWith(
        'listing-1',
        'someone-else',
      );
      expect(suggestions.findAndCount).not.toHaveBeenCalled();
      expect(claims.findAndCount).not.toHaveBeenCalled();
      expect(reports.findAndCount).not.toHaveBeenCalled();
      expect(questions.findAndCount).not.toHaveBeenCalled();
    });

    it('404s when the ref does not exist at all', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.getPendingForOwner('QPL-2026-9999', 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(suggestions.findAndCount).not.toHaveBeenCalled();
    });

    it('lets an active CO-MANAGER read the pending inbox', async () => {
      coManagers.isActiveCoManager.mockResolvedValue(true);

      await expect(
        service.getPendingForOwner('QPL-2026-0001', 'co-manager-1'),
      ).resolves.toBeDefined();
      // Scoped by LISTING, never by the caller: a co-manager sees the same four
      // queues the owner sees, including pending claims and disputes.
      expect(claims.findAndCount).toHaveBeenCalled();
      expect(reports.findAndCount).toHaveBeenCalled();
    });

    it('never consults the seat table for the owner', async () => {
      await service.getPendingForOwner('QPL-2026-0001', 'owner-1');

      expect(coManagers.isActiveCoManager).not.toHaveBeenCalled();
    });
  });

  describe('query scoping', () => {
    it('scopes pending edit suggestions to the listing, newest first, under the item cap', async () => {
      await service.getPendingForOwner('QPL-2026-0001', 'owner-1');

      expect(suggestions.findAndCount).toHaveBeenCalledWith({
        where: {
          listingId: 'listing-1',
          status: ListingEditSuggestionStatus.Pending,
        },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      });
    });

    // The trap this endpoint most easily falls into: a claim is filed BY
    // somebody contesting the current owner, so scoping by `claimantId` would
    // answer a different question and always come back empty for the owner.
    it('scopes pending ownership claims by listing and NEVER by the caller as claimant', async () => {
      await service.getPendingForOwner('QPL-2026-0001', 'owner-1');

      expect(claims.findAndCount).toHaveBeenCalledWith({
        where: {
          listingId: 'listing-1',
          status: ListingClaimStatus.Pending,
        },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      });
      const claimCalls = claims.findAndCount.mock.calls as {
        where: Record<string, unknown>;
      }[][];
      expect(claimCalls[0]![0]!.where).not.toHaveProperty('claimantId');
    });

    it('scopes disputes to this listing slug, the listing_dispute reason code, and open reports only', async () => {
      await service.getPendingForOwner('QPL-2026-0001', 'owner-1');

      expect(reports.findAndCount).toHaveBeenCalledWith({
        where: {
          subjectType: ReportSubjectType.Listing,
          subjectId: 'lux-cafe',
          reasonCode: LISTING_DISPUTE_REASON_CODE,
          status: ReportStatus.Open,
        },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      });
    });

    it('treats an unanswered moderator question as pending', async () => {
      await service.getPendingForOwner('QPL-2026-0001', 'owner-1');

      expect(questions.findAndCount).toHaveBeenCalledWith({
        where: { listingId: 'listing-1', answeredAt: IsNull() },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      });
    });
  });

  describe('response shape', () => {
    it('reports the true totals alongside the capped item arrays', async () => {
      suggestions.findAndCount.mockResolvedValue([[], 300]);
      claims.findAndCount.mockResolvedValue([[], 2]);
      reports.findAndCount.mockResolvedValue([[], 1]);
      questions.findAndCount.mockResolvedValue([[], 4]);

      const pending = await service.getPendingForOwner(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(pending.counts).toEqual({
        editSuggestions: 300,
        ownershipClaims: 2,
        disputes: 1,
        unansweredQuestions: 4,
        total: 307,
      });
    });

    it('gives the owner the full correction so they can confirm it, without the suggester', async () => {
      suggestions.findAndCount.mockResolvedValue([
        [
          {
            id: 'suggestion-1',
            listingId: 'listing-1',
            suggestedByUserId: 'member-9',
            field: 'phone',
            message: 'The number listed rings a dead line.',
            proposedValue: '+351 210 000 000',
            status: ListingEditSuggestionStatus.Pending,
            createdAt: new Date('2026-01-04T00:00:00.000Z'),
            resolvedAt: null,
            resolvedByUserId: null,
          },
        ],
        1,
      ]);

      const pending = await service.getPendingForOwner(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(pending.editSuggestions[0]).toEqual({
        id: 'suggestion-1',
        field: 'phone',
        message: 'The number listed rings a dead line.',
        proposedValue: '+351 210 000 000',
        createdAt: '2026-01-04T00:00:00.000Z',
      });
      expect(JSON.stringify(pending)).not.toContain('member-9');
    });

    it('reduces a claim and a dispute to an id and a timestamp, leaking neither the filer nor their prose', async () => {
      claims.findAndCount.mockResolvedValue([
        [
          {
            id: 'claim-1',
            listingId: 'listing-1',
            claimantId: 'member-7',
            note: 'I am Ana and I actually run this bar.',
            status: ListingClaimStatus.Pending,
            reviewedBy: null,
            reviewedAt: null,
            createdAt: new Date('2026-01-05T00:00:00.000Z'),
          },
        ],
        1,
      ]);
      reports.findAndCount.mockResolvedValue([
        [
          {
            id: 'report-1',
            subjectType: ReportSubjectType.Listing,
            subjectId: 'lux-cafe',
            reasonCode: LISTING_DISPUTE_REASON_CODE,
            detail: 'This is my venue, filed by Ana from the collective.',
            reporterId: 'member-7',
            status: ReportStatus.Open,
            createdAt: new Date('2026-01-06T00:00:00.000Z'),
          },
        ],
        1,
      ]);

      const pending = await service.getPendingForOwner(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(pending.ownershipClaims).toEqual([
        { id: 'claim-1', createdAt: '2026-01-05T00:00:00.000Z' },
      ]);
      expect(pending.disputes).toEqual([
        { id: 'report-1', createdAt: '2026-01-06T00:00:00.000Z' },
      ]);
      const serialized = JSON.stringify(pending);
      expect(serialized).not.toContain('member-7');
      expect(serialized).not.toContain('Ana');
      expect(serialized).not.toContain('collective');
    });

    it("shows an unanswered question's body but not who asked it", async () => {
      questions.findAndCount.mockResolvedValue([
        [
          {
            id: 'question-1',
            listingId: 'listing-1',
            askedBy: 'mod-3',
            body: 'Can you confirm the street number?',
            answer: null,
            answeredAt: null,
            createdAt: new Date('2026-01-07T00:00:00.000Z'),
          },
        ],
        1,
      ]);

      const pending = await service.getPendingForOwner(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(pending.unansweredQuestions[0]).toEqual({
        id: 'question-1',
        body: 'Can you confirm the street number?',
        createdAt: '2026-01-07T00:00:00.000Z',
      });
      expect(JSON.stringify(pending)).not.toContain('mod-3');
    });
  });
});
