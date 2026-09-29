import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, IsNull } from 'typeorm';
import {
  AccessTier,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  CommunitiesService,
  CreateCommunityInput,
} from '../communities/communities.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ReadingGroupProposal,
  ReadingGroupProposalFormat,
  ReadingGroupProposalStatus,
} from './entities/reading-group-proposal.entity';
import { AdminReadingGroupProposalsService } from './admin-reading-group-proposals.service';

function makeProposal(
  overrides: Partial<ReadingGroupProposal> = {},
): ReadingGroupProposal {
  return {
    id: 'proposal-1',
    memberId: 'member-1',
    clubName: 'Queer Classics Club',
    book: "Giovanni's Room by James Baldwin",
    why: 'It changed how I read love stories.',
    format: ReadingGroupProposalFormat.InPerson,
    maxPeople: 6,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    status: ReadingGroupProposalStatus.Pending,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdCommunitySlug: null,
    ...overrides,
  };
}

describe('AdminReadingGroupProposalsService', () => {
  let service: AdminReadingGroupProposalsService;
  let proposals: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let profiles: { find: jest.Mock };
  let communities: { create: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    proposals = {
      findOne: jest.fn(),
      save: jest.fn((value: ReadingGroupProposal) => Promise.resolve(value)),
      update: jest.fn(),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    communities = {
      create: jest.fn((_ownerId: string, input: CreateCommunityInput) =>
        Promise.resolve({ slug: 'new-club', name: input.name }),
      ),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminReadingGroupProposalsService,
        {
          provide: getRepositoryToken(ReadingGroupProposal),
          useValue: proposals,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: CommunitiesService, useValue: communities },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(AdminReadingGroupProposalsService);
  });

  /** Approve `proposal` and hand back the input the community was created with. */
  async function approveAndCaptureInput(
    proposal: ReadingGroupProposal,
  ): Promise<CreateCommunityInput> {
    proposals.findOne.mockResolvedValue(proposal);
    await service.approve(proposal.id, 'admin-1');
    expect(communities.create).toHaveBeenCalledTimes(1);
    const [ownerId, input] = communities.create.mock.calls[0] as [
      string,
      CreateCommunityInput,
    ];
    expect(ownerId).toBe(proposal.memberId);
    return input;
  }

  describe('approve', () => {
    it('names the community and its handle after the club and records the book as now reading', async () => {
      const input = await approveAndCaptureInput(makeProposal());

      expect(input.name).toBe('Queer Classics Club');
      expect(input.handle).toBe('Queer Classics Club');
      expect(input.nowReading).toBe("Giovanni's Room by James Baldwin");
      expect(input.type).toBe(CommunityType.Arts);
      expect(input.accessTier).toBe(AccessTier.Request);
      expect(input.isPubliclyListed).toBe(false);
    });

    it('falls back to the book for the name and handle when the club name is null', async () => {
      const input = await approveAndCaptureInput(
        makeProposal({ clubName: null }),
      );

      expect(input.name).toBe("Giovanni's Room by James Baldwin");
      expect(input.handle).toBe("Giovanni's Room by James Baldwin");
      expect(input.nowReading).toBe("Giovanni's Room by James Baldwin");
    });

    it('falls back to the book for the name and handle when the club name is only whitespace', async () => {
      const input = await approveAndCaptureInput(
        makeProposal({ clubName: '   ' }),
      );

      expect(input.name).toBe("Giovanni's Room by James Baldwin");
      expect(input.handle).toBe("Giovanni's Room by James Baldwin");
    });

    it('keeps a Cyrillic-only club name as the name and seeds the handle from the book', async () => {
      const input = await approveAndCaptureInput(
        makeProposal({ clubName: 'Книжный клуб' }),
      );

      expect(input.name).toBe('Книжный клуб');
      expect(input.handle).toBe("Giovanni's Room by James Baldwin");
    });

    it('uses the trimmed why as the purpose', async () => {
      const input = await approveAndCaptureInput(
        makeProposal({ why: '  It changed how I read love stories.  ' }),
      );

      expect(input.purpose).toBe('It changed how I read love stories.');
    });

    it('uses the full starting-with sentence as the purpose when why is blank', async () => {
      const input = await approveAndCaptureInput(makeProposal({ why: '   ' }));

      expect(input.purpose).toBe(
        "A reading group, starting with Giovanni's Room by James Baldwin.",
      );
      expect(input.tagline).toBe(
        "A reading group, starting with Giovanni's Room by James Baldwin.",
      );
    });

    it('caps the tagline at 200 characters and keeps the whole sentence in the purpose for a 200-character book', async () => {
      const longBook = 'B'.repeat(200);
      const input = await approveAndCaptureInput(
        makeProposal({ book: longBook, why: null }),
      );

      expect(input.tagline).toHaveLength(200);
      expect(input.purpose).toBe(`A reading group, starting with ${longBook}.`);
      expect(input.purpose.endsWith('.')).toBe(true);
    });

    it('maps an online proposal to the virtual tag, the online flag and no city, with the cap in who-for', async () => {
      const input = await approveAndCaptureInput(
        makeProposal({
          format: ReadingGroupProposalFormat.Online,
          maxPeople: 4,
        }),
      );

      expect(input.tags).toEqual(['book-club', 'virtual-online']);
      expect(input.isOnline).toBe(true);
      expect(input.city).toBeNull();
      expect(input.whoFor).toContain('up to 4');
    });

    it('stamps the proposal with the created slug and tells the proposer', async () => {
      proposals.findOne.mockResolvedValue(makeProposal());

      await service.approve('proposal-1', 'admin-1', '  welcome  ');

      const [savedProposal] = proposals.save.mock.calls[0] as [
        ReadingGroupProposal,
      ];
      expect(savedProposal.status).toBe(ReadingGroupProposalStatus.Approved);
      expect(savedProposal.decidedBy).toBe('admin-1');
      expect(savedProposal.decisionNote).toBe('welcome');
      expect(savedProposal.createdCommunitySlug).toBe('new-club');
      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('does not create a second community for a proposal that already carries a created slug', async () => {
      proposals.findOne.mockResolvedValue(
        makeProposal({
          status: ReadingGroupProposalStatus.Approved,
          createdCommunitySlug: 'existing-club',
        }),
      );

      await service.approve('proposal-1', 'admin-1');

      expect(communities.create).not.toHaveBeenCalled();
      expect(proposals.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('decline', () => {
    it.each([
      ReadingGroupProposalStatus.Approved,
      ReadingGroupProposalStatus.Declined,
      ReadingGroupProposalStatus.Archived,
    ])(
      'answers 409 and sends no notification when the proposal is already %s',
      async (status) => {
        proposals.update.mockResolvedValue({ affected: 0 });
        proposals.findOne.mockResolvedValue(makeProposal({ status }));

        await expect(
          service.decline('proposal-1', 'admin-1', 'Off topic for the club.'),
        ).rejects.toThrow(ConflictException);

        expect(proposals.update).toHaveBeenCalledWith(
          {
            id: 'proposal-1',
            status: ReadingGroupProposalStatus.Pending,
            createdCommunitySlug: IsNull(),
          },
          expect.anything(),
        );
        expect(notifications.create).not.toHaveBeenCalled();
      },
    );

    it('notifies the proposer when a pending proposal is declined', async () => {
      proposals.update.mockResolvedValue({ affected: 1 });
      proposals.findOne.mockResolvedValue(
        makeProposal({
          status: ReadingGroupProposalStatus.Declined,
          decidedAt: new Date('2026-09-02T00:00:00.000Z'),
          decidedBy: 'admin-1',
          decisionNote: 'Off topic for the club.',
        }),
      );

      const result = await service.decline(
        'proposal-1',
        'admin-1',
        'Off topic for the club.',
      );

      expect(result.status).toBe(ReadingGroupProposalStatus.Declined);
      expect(notifications.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('archive', () => {
    it('answers 409 when the proposal is already approved', async () => {
      proposals.update.mockResolvedValue({ affected: 0 });
      proposals.findOne.mockResolvedValue(
        makeProposal({ status: ReadingGroupProposalStatus.Approved }),
      );

      await expect(service.archive('proposal-1', 'admin-1')).rejects.toThrow(
        ConflictException,
      );

      expect(proposals.update).toHaveBeenCalledWith(
        {
          id: 'proposal-1',
          status: In([
            ReadingGroupProposalStatus.Pending,
            ReadingGroupProposalStatus.Declined,
          ]),
          createdCommunitySlug: IsNull(),
        },
        expect.anything(),
      );
    });

    it('succeeds when a declined proposal is archived', async () => {
      proposals.update.mockResolvedValue({ affected: 1 });
      proposals.findOne.mockResolvedValue(
        makeProposal({
          status: ReadingGroupProposalStatus.Archived,
          decidedAt: new Date('2026-09-02T00:00:00.000Z'),
          decidedBy: 'admin-1',
        }),
      );

      const result = await service.archive('proposal-1', 'admin-1');

      expect(result.status).toBe(ReadingGroupProposalStatus.Archived);
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
