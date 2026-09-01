import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { Profile } from '../users/entities/profile.entity';
import { BarterService } from './barter.service';
import {
  BarterCategory,
  BarterListing,
  BarterListingStatus,
  BarterMode,
} from './entities/barter-listing.entity';
import {
  BarterProposal,
  BarterProposalStatus,
} from './entities/barter-proposal.entity';

// A jest-mocked repo/service typed by exactly the method names it needs.
// Unlike `Record<string, jest.Mock>`, a literal key union produces named
// properties rather than an index signature, so `noUncheckedIndexedAccess`
// never widens a method access to `jest.Mock | undefined`.
type MockMethods<MethodName extends string> = Record<MethodName, jest.Mock>;

// Returns the first row of a list, or fails the test loudly if the service
// under test returned none — `noUncheckedIndexedAccess` types array
// destructuring as possibly-`undefined`, and this keeps that honest instead
// of masking it with a non-null assertion.
function firstOrThrow<Row>(rows: Row[]): Row {
  const [row] = rows;
  if (!row) throw new Error('expected at least one row, got none');
  return row;
}

// Chainable query-builder stub whose terminal methods resolve empty by default
// (mirrors `volunteering.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'limit',
    'offset',
    'update',
    'set',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return qb;
};

const OWNER_ID = 'owner-1';
const PROPOSER_ID = 'proposer-1';
const LISTING_ID = '11111111-1111-4111-8111-111111111111';

function listingRow(overrides: Partial<BarterListing> = {}): BarterListing {
  return {
    id: LISTING_ID,
    ownerId: OWNER_ID,
    category: BarterCategory.Creative,
    mode: BarterMode.Both,
    offer: 'Brand identity design',
    want: 'Tax return help',
    offerDetail: 'Logo, type, colour.',
    wantDetail: 'Two hours of your time.',
    tags: ['design'],
    status: BarterListingStatus.Open,
    materialEditedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// Only the fields the owner-ref mapper reads need to be present — the repo is
// a jest mock, so this is not type-constrained to the full `Profile` entity.
function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: OWNER_ID,
    slug: 'nadia-osei',
    firstName: 'Nadia',
    lastName: 'Osei',
    pronouns: 'she/her',
    avatarUrl: null,
    photoVisible: true,
    hoodVisible: true,
    location: 'Anjos, Lisboa',
    ...overrides,
  };
}

describe('BarterService', () => {
  let service: BarterService;
  let listings: MockMethods<
    'findOne' | 'find' | 'create' | 'save' | 'createQueryBuilder'
  >;
  let proposals: MockMethods<
    'find' | 'findOne' | 'create' | 'save' | 'createQueryBuilder'
  >;
  let profiles: MockMethods<'find' | 'findOne' | 'createQueryBuilder'>;
  let blockFilter: MockMethods<
    'isBlockedEitherWay' | 'excludeHidden' | 'hiddenUserIds'
  >;
  let messaging: { deliverEnquiry: jest.Mock };
  let notifications: {
    create: jest.Mock<
      Promise<null>,
      [
        userId: string,
        type: NotificationType,
        payload?: Record<string, unknown>,
        actorId?: string,
      ]
    >;
  };
  // Typed by its argument list so reading `mock.calls[0][0]` below is a real
  // shape rather than an `any` the lint rules have to wave through.
  let submissionDecisions: {
    notifyDecided: jest.Mock<Promise<void>, [Record<string, unknown>]>;
  };
  let managerFindOne: jest.Mock;

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(listingRow()),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: object) => value),
      save: jest.fn((value: unknown) =>
        Promise.resolve({
          id: LISTING_ID,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(value as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    proposals = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      save: jest.fn((value: unknown) =>
        Promise.resolve({
          id: 'proposal-1',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          decidedAt: null,
          ...(value as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      excludeHidden: jest.fn(),
      hiddenUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    messaging = {
      deliverEnquiry: jest
        .fn()
        .mockResolvedValue({ conversationId: 'conversation-1' }),
    };
    notifications = {
      create: jest
        .fn<
          Promise<null>,
          [
            userId: string,
            type: NotificationType,
            payload?: Record<string, unknown>,
            actorId?: string,
          ]
        >()
        .mockResolvedValue(null),
    };
    submissionDecisions = {
      notifyDecided: jest
        .fn<Promise<void>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
    };
    managerFindOne = jest.fn().mockResolvedValue(listingRow());

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === BarterListing) return listings;
        if (entity === BarterProposal) return proposals;
        throw new Error(`unexpected entity: ${String(entity)}`);
      }),
      findOne: managerFindOne,
    };
    const dataSource = {
      transaction: jest.fn(
        async (callback: (m: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BarterService,
        { provide: getRepositoryToken(BarterListing), useValue: listings },
        { provide: getRepositoryToken(BarterProposal), useValue: proposals },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: MessagingService, useValue: messaging },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: SubmissionDecisionNotifier,
          useValue: submissionDecisions,
        },
      ],
    }).compile();

    service = module.get(BarterService);
  });

  describe('create', () => {
    it('rejects an offering post with nothing on offer', async () => {
      await expect(
        service.create(OWNER_ID, {
          category: BarterCategory.Tech,
          mode: BarterMode.Offering,
          offer: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a seeking post with nothing wanted', async () => {
      await expect(
        service.create(OWNER_ID, {
          category: BarterCategory.Tech,
          mode: BarterMode.Seeking,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('trims and de-duplicates tags', async () => {
      await service.create(OWNER_ID, {
        category: BarterCategory.Tech,
        mode: BarterMode.Offering,
        offer: 'Website build',
        tags: [' react ', 'react', '', 'javascript'],
      });
      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['react', 'javascript'] }),
      );
    });
  });

  describe('list', () => {
    it('applies the block/mute filter to the board query', async () => {
      await service.list(PROPOSER_ID, {});
      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        expect.anything(),
        PROPOSER_ID,
        '"listing"."owner_id"',
      );
    });

    it('keeps "both" listings under the offering tab', async () => {
      const qb = qbStub();
      listings.createQueryBuilder.mockReturnValue(qb);
      await service.list(PROPOSER_ID, { mode: BarterMode.Offering });
      expect(qb.andWhere).toHaveBeenCalledWith('listing.mode IN (:...modes)', {
        modes: [BarterMode.Offering, BarterMode.Both],
      });
    });
  });

  describe('getById', () => {
    it('reads as 404 when the pair is blocked, never 403', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.getById(LISTING_ID, PROPOSER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createProposal', () => {
    const dto = { message: 'I can trade you two hours of tax help.' };

    it('refuses a proposal on your own listing', async () => {
      await expect(
        service.createProposal(LISTING_ID, OWNER_ID, dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a blocked pair before taking the lock', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.createProposal(LISTING_ID, PROPOSER_ID, dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(managerFindOne).not.toHaveBeenCalled();
    });

    it('refuses a closed listing', async () => {
      managerFindOne.mockResolvedValue(
        listingRow({ status: BarterListingStatus.Closed }),
      );
      await expect(
        service.createProposal(LISTING_ID, PROPOSER_ID, dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a second pending proposal from the same member', async () => {
      proposals.findOne.mockResolvedValue({
        id: 'proposal-1',
        status: BarterProposalStatus.Pending,
      });
      await expect(
        service.createProposal(LISTING_ID, PROPOSER_ID, dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('reactivates a declined proposal instead of stacking a new row', async () => {
      const declined = {
        id: 'proposal-1',
        listingId: LISTING_ID,
        proposerId: PROPOSER_ID,
        message: 'old',
        status: BarterProposalStatus.Declined,
        decidedAt: new Date('2026-01-03T00:00:00.000Z'),
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      };
      proposals.findOne.mockResolvedValue(declined);

      await service.createProposal(LISTING_ID, PROPOSER_ID, dto);

      expect(proposals.create).not.toHaveBeenCalled();
      expect(proposals.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'proposal-1',
          status: BarterProposalStatus.Pending,
          decidedAt: null,
          message: dto.message,
        }),
      );
    });

    it('delivers the proposal to the listing owner and returns the thread', async () => {
      const result = await service.createProposal(LISTING_ID, PROPOSER_ID, dto);
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        PROPOSER_ID,
        OWNER_ID,
        dto.message,
      );
      expect(result.conversationId).toBe('conversation-1');
      expect(result.proposal.status).toBe(BarterProposalStatus.Pending);
    });

    it('still succeeds when inbox delivery fails after the commit', async () => {
      messaging.deliverEnquiry.mockRejectedValue(new Error('inbox down'));
      const result = await service.createProposal(LISTING_ID, PROPOSER_ID, dto);
      expect(result.conversationId).toBeNull();
      expect(result.proposal.id).toBe('proposal-1');
    });

    it('rings the owner bell with the proposer as the actor', async () => {
      await service.createProposal(LISTING_ID, PROPOSER_ID, dto);
      expect(notifications.create).toHaveBeenCalledWith(
        OWNER_ID,
        NotificationType.BarterProposalReceived,
        expect.any(Object),
        PROPOSER_ID,
      );
    });

    it('carries only the listing keys in the payload, never the message', async () => {
      await service.createProposal(LISTING_ID, PROPOSER_ID, dto);
      const payload = firstOrThrow(
        notifications.create.mock.calls,
      )[2] as Record<string, unknown>;
      // Exactly the routing key plus the two allowlisted display keys.
      expect(payload).toEqual({
        source: 'barter',
        barterListingId: LISTING_ID,
        listingOffer: 'Brand identity design',
      });
      // The proposer's own words are private to the DM thread — they must
      // never be written into the notification payload under ANY key.
      expect(JSON.stringify(payload)).not.toContain(dto.message);
      expect(payload).not.toHaveProperty('message');
    });

    it('still succeeds when the notification fails after the commit', async () => {
      notifications.create.mockRejectedValue(new Error('bell down'));
      const result = await service.createProposal(LISTING_ID, PROPOSER_ID, dto);
      expect(result.proposal.id).toBe('proposal-1');
      expect(result.conversationId).toBe('conversation-1');
    });
  });

  describe('owner hood', () => {
    beforeEach(() => {
      listings.find.mockResolvedValue([listingRow()]);
    });

    it('resolves the neighbourhood from the owner location', async () => {
      profiles.find.mockResolvedValue([profileRow()]);
      const card = firstOrThrow(await service.listMine(OWNER_ID));
      expect(card.member?.hood).toBe('Anjos');
    });

    it('omits the hood when the owner hid it', async () => {
      profiles.find.mockResolvedValue([profileRow({ hoodVisible: false })]);
      const card = firstOrThrow(await service.listMine(OWNER_ID));
      // The rest of the ref still renders — only the hood is withheld.
      expect(card.member?.slug).toBe('nadia-osei');
      expect(card.member?.hood).toBeNull();
    });

    it('reads every owner on the board in a single profile query', async () => {
      const qb = qbStub();
      qb.getManyAndCount = jest
        .fn()
        .mockResolvedValue([
          [listingRow(), listingRow({ id: 'listing-2', ownerId: 'owner-2' })],
          2,
        ]);
      listings.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([profileRow()]);

      await service.list(PROPOSER_ID, {});

      expect(profiles.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('listProposals', () => {
    it('refuses a reader who does not own the listing', async () => {
      await expect(
        service.listProposals(LISTING_ID, PROPOSER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('drops proposers the owner has since blocked or muted', async () => {
      proposals.find.mockResolvedValue([
        {
          id: 'proposal-1',
          listingId: LISTING_ID,
          proposerId: PROPOSER_ID,
          message: 'hello',
          status: BarterProposalStatus.Pending,
          decidedAt: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);
      blockFilter.hiddenUserIds.mockResolvedValue(new Set([PROPOSER_ID]));

      await expect(
        service.listProposals(LISTING_ID, OWNER_ID),
      ).resolves.toEqual([]);
    });
  });

  describe('decideProposal', () => {
    const pendingRow = {
      id: 'proposal-1',
      listingId: LISTING_ID,
      proposerId: PROPOSER_ID,
      message: 'hello',
      status: BarterProposalStatus.Pending,
      decidedAt: null,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    };

    it('refuses a decision from someone other than the poster', async () => {
      await expect(
        service.decideProposal(
          LISTING_ID,
          'proposal-1',
          PROPOSER_ID,
          BarterProposalStatus.Accepted,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('409s when the guarded claim update matches nothing', async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      const qb = qbStub();
      qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
      proposals.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.decideProposal(
          LISTING_ID,
          'proposal-1',
          OWNER_ID,
          BarterProposalStatus.Accepted,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts a pending proposal', async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      const decided = await service.decideProposal(
        LISTING_ID,
        'proposal-1',
        OWNER_ID,
        BarterProposalStatus.Accepted,
      );
      expect(decided.status).toBe(BarterProposalStatus.Accepted);
      expect(decided.decidedAt).not.toBeNull();
    });

    it('409s on a proposal that was already decided', async () => {
      proposals.findOne.mockResolvedValue({
        ...pendingRow,
        status: BarterProposalStatus.Declined,
      });
      await expect(
        service.decideProposal(
          LISTING_ID,
          'proposal-1',
          OWNER_ID,
          BarterProposalStatus.Accepted,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // PRD-43. Before this the proposer was told nothing at all: the status was
    // written and the method returned.
    it('tells the proposer their swap was accepted', async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      await service.decideProposal(
        LISTING_ID,
        'proposal-1',
        OWNER_ID,
        BarterProposalStatus.Accepted,
      );
      expect(submissionDecisions.notifyDecided).toHaveBeenCalledTimes(1);
      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith({
        recipientId: PROPOSER_ID,
        kind: SubmissionKind.BarterProposal,
        outcome: SubmissionOutcome.Accepted,
        subjectLabel: 'Brand identity design',
      });
    });

    it('tells the proposer their swap was declined', async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      await service.decideProposal(
        LISTING_ID,
        'proposal-1',
        OWNER_ID,
        BarterProposalStatus.Declined,
      );
      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: SubmissionOutcome.Declined }),
      );
    });

    // The proposal's own message is member-authored private text: it belongs in
    // the DM thread the proposal opened, never in a notification payload. Same
    // rule `BarterProposalReceived` states for the owner's side.
    it("never carries the proposer's own message into the notice", async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      await service.decideProposal(
        LISTING_ID,
        'proposal-1',
        OWNER_ID,
        BarterProposalStatus.Accepted,
      );
      const notice = submissionDecisions.notifyDecided.mock.calls[0]?.[0] ?? {};
      expect(JSON.stringify(notice)).not.toContain(pendingRow.message);
      expect(notice).not.toHaveProperty('message');
      expect(notice).not.toHaveProperty('reviewNote');
    });

    it('emits nothing when the decision was refused', async () => {
      proposals.findOne.mockResolvedValue({
        ...pendingRow,
        status: BarterProposalStatus.Accepted,
      });
      await expect(
        service.decideProposal(
          LISTING_ID,
          'proposal-1',
          OWNER_ID,
          BarterProposalStatus.Declined,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('emits nothing when a concurrent decision won the claim', async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      const qb = qbStub();
      qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
      proposals.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.decideProposal(
          LISTING_ID,
          'proposal-1',
          OWNER_ID,
          BarterProposalStatus.Accepted,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('still stores the decision when the notification fails', async () => {
      proposals.findOne.mockResolvedValue({ ...pendingRow });
      submissionDecisions.notifyDecided.mockRejectedValue(
        new Error('bell down'),
      );
      const decided = await service.decideProposal(
        LISTING_ID,
        'proposal-1',
        OWNER_ID,
        BarterProposalStatus.Accepted,
      );
      expect(decided.status).toBe(BarterProposalStatus.Accepted);
    });
  });

  describe('update', () => {
    it('refuses an edit from someone other than the poster with a 403', async () => {
      await expect(
        service.update(LISTING_ID, PROPOSER_ID, { offer: 'Something else' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s on a listing that is not there', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.update(LISTING_ID, OWNER_ID, { offer: 'Something else' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leaves an omitted field alone', async () => {
      await service.update(LISTING_ID, OWNER_ID, { offerDetail: 'New copy.' });
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          offer: 'Brand identity design',
          want: 'Tax return help',
          offerDetail: 'New copy.',
        }),
      );
    });

    it('trims what it stores', async () => {
      await service.update(LISTING_ID, OWNER_ID, { offer: '  Logo work  ' });
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ offer: 'Logo work' }),
      );
    });

    // The merged values are validated, so patching `mode` alone can never leave
    // a post advertising a side it does not carry.
    it('refuses a mode change the existing sides cannot satisfy', async () => {
      listings.findOne.mockResolvedValue(listingRow({ want: '' }));
      await expect(
        service.update(LISTING_ID, OWNER_ID, { mode: BarterMode.Seeking }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses emptying a headline the mode still advertises', async () => {
      await expect(
        service.update(LISTING_ID, OWNER_ID, { offer: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('de-duplicates tags exactly as create does', async () => {
      await service.update(LISTING_ID, OWNER_ID, {
        tags: [' design ', 'design', '', 'branding'],
      });
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['design', 'branding'] }),
      );
    });

    // The trap this stamp exists to close: somebody offered against what the
    // post said, and the post now says something else.
    it('stamps a material edit made under a pending proposal', async () => {
      const qb = qbStub();
      qb.getRawMany = jest
        .fn()
        .mockResolvedValue([{ listingId: LISTING_ID, count: '2' }]);
      proposals.createQueryBuilder.mockReturnValue(qb);

      const updated = await service.update(LISTING_ID, OWNER_ID, {
        offer: 'Something materially different',
      });

      // The sibling tests below pin the un-stamped case to `null`, so "not
      // null" is exactly what a stamp means here.
      expect(listings.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ materialEditedAt: null }),
      );
      expect(updated.pendingProposalCount).toBe(2);
    });

    it('does not stamp a cosmetic edit', async () => {
      const qb = qbStub();
      qb.getRawMany = jest
        .fn()
        .mockResolvedValue([{ listingId: LISTING_ID, count: '2' }]);
      proposals.createQueryBuilder.mockReturnValue(qb);

      await service.update(LISTING_ID, OWNER_ID, {
        offerDetail: 'Same deal, better words.',
        tags: ['design'],
      });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ materialEditedAt: null }),
      );
    });

    it('does not stamp when nobody is waiting on the swap', async () => {
      await service.update(LISTING_ID, OWNER_ID, {
        offer: 'Something materially different',
      });
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ materialEditedAt: null }),
      );
    });
  });

  describe('listMySentProposals', () => {
    const sentRow = {
      id: 'proposal-1',
      listingId: LISTING_ID,
      proposerId: PROPOSER_ID,
      message: 'I can trade you two hours of tax help.',
      status: BarterProposalStatus.Pending,
      decidedAt: null,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    };

    function sentQueryBuilder(rows: unknown[]) {
      const qb = qbStub();
      qb.getMany = jest.fn().mockResolvedValue(rows);
      proposals.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('answers empty with no rows, without touching the listings', async () => {
      sentQueryBuilder([]);
      await expect(service.listMySentProposals(PROPOSER_ID)).resolves.toEqual(
        [],
      );
      expect(listings.find).not.toHaveBeenCalled();
    });

    // `created_at DESC` alone is not deterministic when two timestamps tie.
    it('orders newest first with an id tiebreak', async () => {
      const qb = sentQueryBuilder([]);
      await service.listMySentProposals(PROPOSER_ID);
      expect(qb.orderBy).toHaveBeenCalledWith('proposal.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('proposal.id', 'DESC');
    });

    it('returns the outcome and the listing it was made against', async () => {
      sentQueryBuilder([sentRow]);
      listings.find.mockResolvedValue([listingRow()]);
      profiles.find.mockResolvedValue([profileRow()]);

      const row = firstOrThrow(await service.listMySentProposals(PROPOSER_ID));
      expect(row.status).toBe(BarterProposalStatus.Pending);
      expect(row.listing?.offer).toBe('Brand identity design');
      expect(row.listing?.member?.slug).toBe('nadia-osei');
    });

    // No owner-written reasoning field exists on a barter decision, and the
    // raw entity is never returned, so `proposerId` cannot ride along either.
    it('leaks no owner-side column onto the wire', async () => {
      sentQueryBuilder([sentRow]);
      listings.find.mockResolvedValue([listingRow()]);

      const row = firstOrThrow(await service.listMySentProposals(PROPOSER_ID));
      expect(row).not.toHaveProperty('proposerId');
      expect(row).not.toHaveProperty('reviewNote');
      expect(row.listing).not.toHaveProperty('ownerId');
      expect(row.listing).not.toHaveProperty('offerDetail');
    });

    it('flags a listing the poster changed after the proposal went out', async () => {
      sentQueryBuilder([sentRow]);
      listings.find.mockResolvedValue([
        listingRow({ materialEditedAt: new Date('2026-01-03T00:00:00.000Z') }),
      ]);

      const row = firstOrThrow(await service.listMySentProposals(PROPOSER_ID));
      expect(row.wasListingEditedAfterProposal).toBe(true);
    });

    it('does not flag an edit that predates the proposal', async () => {
      sentQueryBuilder([sentRow]);
      listings.find.mockResolvedValue([
        listingRow({ materialEditedAt: new Date('2026-01-01T12:00:00.000Z') }),
      ]);

      const row = firstOrThrow(await service.listMySentProposals(PROPOSER_ID));
      expect(row.wasListingEditedAfterProposal).toBe(false);
    });

    // The proposer keeps their own record; only the poster's half is severed.
    it('withholds the listing when the pair has since blocked', async () => {
      sentQueryBuilder([sentRow]);
      listings.find.mockResolvedValue([listingRow()]);
      blockFilter.hiddenUserIds.mockResolvedValue(new Set([OWNER_ID]));

      const row = firstOrThrow(await service.listMySentProposals(PROPOSER_ID));
      expect(row.listing).toBeNull();
      expect(row.message).toBe(sentRow.message);
    });

    it('keeps the row when the listing itself is gone', async () => {
      sentQueryBuilder([sentRow]);
      listings.find.mockResolvedValue([]);

      const row = firstOrThrow(await service.listMySentProposals(PROPOSER_ID));
      expect(row.listing).toBeNull();
      expect(row.listingId).toBe(LISTING_ID);
    });
  });
});
