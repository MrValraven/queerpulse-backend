import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Profile } from '../users/entities/profile.entity';
import {
  Partner,
  PartnerRegion,
  PartnerStatus,
} from './entities/partner.entity';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { PartnersService } from './partners.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('PartnersService', () => {
  let service: PartnersService;
  let partners: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    find: jest.Mock;
  };
  // PRD-37. `notifyDecided` is documented as never throwing, so the default
  // stub resolves; the failure case is forced per-test.
  let submissionDecisions: { notifyDecided: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  const baseDto = {
    name: 'ILGA Portugal',
    logo: 'IP',
    region: PartnerRegion.Pt,
    regionLabel: 'Portugal',
    city: 'Lisbon',
    desc: 'Advocacy and support for LGBTI+ rights.',
    tier: 'Founding partner',
    since: '2019',
    eyebrow: 'Rights & advocacy',
    tagline: 'Rights, not favors.',
  };

  beforeEach(async () => {
    partners = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (the A4 lesson, mirrored from
      // `companies.service.spec.ts`/`volunteering.service.spec.ts`).
      save: jest.fn((p: unknown) =>
        Promise.resolve({
          id: 'partner-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(p as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
    };
    submissionDecisions = {
      notifyDecided: jest.fn().mockResolvedValue(undefined),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnersService,
        { provide: getRepositoryToken(Partner), useValue: partners },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: SubmissionDecisionNotifier,
          useValue: submissionDecisions,
        },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(PartnersService);
  });

  describe('list', () => {
    it('filters to approved partners only', async () => {
      await service.list({});

      const qb = partners.createQueryBuilder.mock.results[0]!.value as {
        where: jest.Mock;
        andWhere: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('p.status = :status', {
        status: PartnerStatus.Approved,
      });
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('adds a region filter when provided', async () => {
      await service.list({ region: PartnerRegion.Eu });

      const qb = partners.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('p.region = :region', {
        region: PartnerRegion.Eu,
      });
    });

    it('adds a featured filter when provided', async () => {
      await service.list({ featured: true });

      const qb = partners.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).toHaveBeenCalledWith('p.featured = :featured', {
        featured: true,
      });
    });

    it('omits the featured filter when not provided', async () => {
      await service.list({});

      const qb = partners.createQueryBuilder.mock.results[0]!.value as {
        andWhere: jest.Mock;
      };
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'p.featured = :featured',
        expect.anything(),
      );
    });
  });

  describe('getBySlug', () => {
    it('404s an unknown slug', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s a pending partner (hides existence from the public)', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        slug: 'ilga-portugal',
        status: PartnerStatus.Pending,
      });
      await expect(service.getBySlug('ilga-portugal')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns an approved partner', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        slug: 'ilga-portugal',
        name: 'ILGA Portugal',
        logo: 'IP',
        region: PartnerRegion.Pt,
        regionLabel: 'Portugal',
        city: 'Lisbon',
        desc: 'Advocacy and support.',
        tags: [],
        tier: 'Founding partner',
        since: '2019',
        eyebrow: 'Rights & advocacy',
        tagline: 'Rights, not favors.',
        about: [],
        stats: [],
        aboutMore: [],
        jointWork: [],
        timeline: [],
        how: [],
        funding: '',
        atGlance: [],
        contact: {
          phone: null,
          phoneNote: null,
          email: null,
          website: null,
          address: null,
        },
        status: PartnerStatus.Approved,
        submittedById: 'submitter-1',
        reviewNote: null,
        featured: true,
        testimonialQuote: 'They showed up when no one else did.',
        testimonialAuthor: 'Marta Silva',
        testimonialRole: 'Community organizer',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const detail = await service.getBySlug('ilga-portugal');
      expect(detail.slug).toBe('ilga-portugal');
      expect(detail.name).toBe('ILGA Portugal');
      expect(detail.featured).toBe(true);
      expect(detail.testimonialQuote).toBe(
        'They showed up when no one else did.',
      );
      expect(detail.testimonialAuthor).toBe('Marta Silva');
      expect(detail.testimonialRole).toBe('Community organizer');
    });

    it('surfaces a non-featured partner with no testimonial as null', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-2',
        slug: 'trans-lisboa',
        name: 'Trans Lisboa',
        logo: 'TL',
        region: PartnerRegion.Pt,
        regionLabel: 'Portugal',
        city: 'Lisbon',
        desc: 'Peer support for trans people.',
        tags: [],
        tier: 'Community partner',
        since: '2021',
        eyebrow: 'Peer support',
        tagline: 'By us, for us.',
        about: [],
        stats: [],
        aboutMore: [],
        jointWork: [],
        timeline: [],
        how: [],
        funding: '',
        atGlance: [],
        contact: {
          phone: null,
          phoneNote: null,
          email: null,
          website: null,
          address: null,
        },
        status: PartnerStatus.Approved,
        submittedById: 'submitter-2',
        reviewNote: null,
        featured: false,
        testimonialQuote: null,
        testimonialAuthor: null,
        testimonialRole: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const detail = await service.getBySlug('trans-lisboa');
      expect(detail.featured).toBe(false);
      expect(detail.testimonialQuote).toBeNull();
      expect(detail.testimonialAuthor).toBeNull();
      expect(detail.testimonialRole).toBeNull();
    });
  });

  describe('submitApplication', () => {
    it('creates a pending application with the submitter set', async () => {
      const res = await service.submitApplication('member-1', {
        ...baseDto,
        handle: 'ilga-portugal',
      });

      expect(res.slug).toBe('ilga-portugal');
      expect(res.status).toBe('pending');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PartnerStatus.Pending,
          submittedById: 'member-1',
        }),
      );
    });

    it('normalizes contact subfields to null when omitted', async () => {
      await service.submitApplication('member-1', {
        ...baseDto,
        handle: 'ilga-portugal',
        contact: { email: 'geral@ilga-portugal.pt' },
      });

      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          contact: {
            phone: null,
            phoneNote: null,
            email: 'geral@ilga-portugal.pt',
            website: null,
            address: null,
          },
        }),
      );
    });

    it('tells the partner-application queue with the saved row id', async () => {
      await service.submitApplication('member-1', {
        ...baseDto,
        handle: 'ilga-portugal',
      });

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.PartnerApplications,
        'partner-1',
      );
    });

    it('tells nobody when the application is never saved', async () => {
      partners.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.submitApplication('member-1', {
          ...baseDto,
          handle: 'ilga-portugal',
        }),
      ).rejects.toThrow('write failed');
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });

  describe('listApplications', () => {
    it('lists only pending applications', async () => {
      await service.listApplications();
      expect(partners.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: PartnerStatus.Pending },
        }),
      );
    });
  });

  describe('listApproved', () => {
    it('lists only approved partners, newest first', async () => {
      await service.listApproved();
      expect(partners.find).toHaveBeenCalledWith({
        where: { status: PartnerStatus.Approved },
        order: { createdAt: 'DESC' },
        take: 200,
      });
    });

    it('returns an empty array when there are no approved partners', async () => {
      partners.find.mockResolvedValue([]);
      const res = await service.listApproved();
      expect(res).toEqual([]);
    });

    it('maps rows through buildApplications into the application shape', async () => {
      partners.find.mockResolvedValue([
        {
          id: 'partner-1',
          status: PartnerStatus.Approved,
          submittedById: 'submitter-1',
          reviewNote: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      const res = await service.listApproved();

      expect(res).toHaveLength(1);
      expect(res[0]).toEqual(
        expect.objectContaining({
          id: 'partner-1',
          status: PartnerStatus.Approved,
        }),
      );
    });
  });

  describe('listMine', () => {
    it('scopes to the caller and never to a status', async () => {
      await service.listMine('submitter-1');

      // Every status is included on purpose: a rejected application is
      // precisely the one the applicant most needs to be able to find.
      expect(partners.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { submittedById: 'submitter-1' },
        }),
      );
    });

    it('orders newest first with an id tiebreak', async () => {
      await service.listMine('submitter-1');

      // `createdAt` alone is not a total order: two applications saved in the
      // same millisecond would come back in whatever order Postgres felt like,
      // and a client merging or paging this would show one twice.
      expect(partners.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { createdAt: 'DESC', id: 'DESC' },
        }),
      );
    });

    it('returns an empty array for a member who has never applied', async () => {
      partners.find.mockResolvedValue([]);
      await expect(service.listMine('submitter-1')).resolves.toEqual([]);
    });

    const rejectedRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'partner-1',
      slug: 'ilga-portugal',
      name: 'ILGA Portugal',
      city: 'Lisbon',
      tagline: 'Rights, not favors.',
      status: PartnerStatus.Rejected,
      submittedById: 'submitter-1',
      reviewNote: 'Overlaps an existing partner; revisit in the autumn',
      assignedStaffId: 'staff-1',
      assignedAt: new Date('2026-01-02T00:00:00.000Z'),
      dueAt: new Date('2026-01-15T00:00:00.000Z'),
      featured: false,
      testimonialQuote: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      decidedAt: new Date('2026-01-09T12:00:00.000Z'),
      ...overrides,
    });

    it('withholds the reviewer, the internal due clock and the editorial fields', async () => {
      partners.find.mockResolvedValue([rejectedRow()]);

      const [application] = await service.listMine('submitter-1');

      // The whole object, not a field-by-field check: an exact match is what
      // catches a field ADDED to the mapper later, which a set of
      // `not.toHaveProperty` assertions would sail straight past.
      expect(application).toEqual({
        id: 'partner-1',
        slug: 'ilga-portugal',
        name: 'ILGA Portugal',
        city: 'Lisbon',
        tagline: 'Rights, not favors.',
        status: PartnerStatus.Rejected,
        createdAt: '2026-01-01T00:00:00.000Z',
        decidedAt: '2026-01-09T12:00:00.000Z',
        reviewNote: 'Overlaps an existing partner; revisit in the autumn',
      });
    });

    it('withholds a review note from a decision made before the date was recorded', async () => {
      // `decidedAt: null` on a decided row is exactly the set of applications
      // settled before PRD-48 made this note member-facing. Those notes were
      // written by reviewers with every reason to believe they were private,
      // and no notification ever carried them, so they stay put.
      partners.find.mockResolvedValue([rejectedRow({ decidedAt: null })]);

      const [application] = await service.listMine('submitter-1');

      expect(application!.status).toBe(PartnerStatus.Rejected);
      expect(application!.reviewNote).toBeNull();
    });

    it('does not carry a stale refusal note on an application later approved', async () => {
      // `triage` never clears `reviewNote`, so an application refused once and
      // approved on a second pass still has the refusal sitting in the column.
      partners.find.mockResolvedValue([
        rejectedRow({ status: PartnerStatus.Approved }),
      ]);

      const [application] = await service.listMine('submitter-1');

      expect(application!.status).toBe(PartnerStatus.Approved);
      expect(application!.reviewNote).toBeNull();
    });

    it('reports a still-pending application with no decision date', async () => {
      partners.find.mockResolvedValue([
        {
          id: 'partner-1',
          slug: 'casa-arco',
          name: 'Casa Arco',
          city: 'Lisbon',
          tagline: 'A daytime space.',
          status: PartnerStatus.Pending,
          submittedById: 'submitter-1',
          reviewNote: null,
          assignedStaffId: null,
          dueAt: new Date('2026-01-15T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          decidedAt: null,
        },
      ]);

      const [application] = await service.listMine('submitter-1');

      expect(application!.status).toBe(PartnerStatus.Pending);
      expect(application!.decidedAt).toBeNull();
    });
  });

  describe('triage', () => {
    it('404s an unknown id', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(service.triage('nope', 'approve')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('flips status to approved without touching reviewNote', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
        submittedById: 'submitter-1',
        reviewNote: null,
      });

      const res = await service.triage('partner-1', 'approve');

      expect(res.status).toBe('approved');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PartnerStatus.Approved }),
      );
    });

    it('flips status to rejected and sets reviewNote', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
        submittedById: 'submitter-1',
        reviewNote: null,
      });

      const res = await service.triage(
        'partner-1',
        'reject',
        'Not a fit for the directory',
      );

      expect(res.status).toBe('rejected');
      expect(res.reviewNote).toBe('Not a fit for the directory');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PartnerStatus.Rejected,
          reviewNote: 'Not a fit for the directory',
        }),
      );
    });

    it('stamps decidedAt on the first decision', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
        submittedById: 'submitter-1',
        reviewNote: null,
        decidedAt: null,
      });

      await service.triage('partner-1', 'approve', undefined, 'admin-1');

      const [[saved]] = partners.save.mock.calls as [[{ decidedAt: Date }]];
      expect(saved.decidedAt).toBeInstanceOf(Date);
    });

    it('leaves the original decidedAt alone when a rejection note is corrected', async () => {
      const originalDecidedAt = new Date('2026-01-09T12:00:00.000Z');
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Rejected,
        submittedById: 'submitter-1',
        reviewNote: 'Typo in the first note',
        decidedAt: originalDecidedAt,
      });

      await service.triage(
        'partner-1',
        'reject',
        'Overlaps an existing partner',
        'admin-1',
      );

      const [[saved]] = partners.save.mock.calls as [
        [{ decidedAt: Date; reviewNote: string }],
      ];
      // The note is corrected, the decision date is not: it records when the
      // applicant was told, and they were told once.
      expect(saved.reviewNote).toBe('Overlaps an existing partner');
      expect(saved.decidedAt).toBe(originalDecidedAt);
    });
  });

  // PRD-37. Before this, an application was approved or rejected and nothing
  // whatsoever reached the organisation that applied.
  describe('triage decision notification', () => {
    const pendingRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'partner-1',
      name: 'ILGA Portugal',
      status: PartnerStatus.Pending,
      submittedById: 'submitter-1',
      reviewNote: null,
      decidedAt: null,
      ...overrides,
    });

    it('tells the applicant an approval was accepted, with no note attached', async () => {
      partners.findOne.mockResolvedValue(pendingRow());

      await service.triage('partner-1', 'approve', undefined, 'admin-1');

      expect(submissionDecisions.notifyDecided).toHaveBeenCalledTimes(1);
      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith({
        recipientId: 'submitter-1',
        kind: SubmissionKind.PartnerApplication,
        outcome: SubmissionOutcome.Accepted,
        subjectLabel: 'ILGA Portugal',
        reviewNote: null,
      });
    });

    it('tells the applicant a rejection was declined, carrying the reason', async () => {
      partners.findOne.mockResolvedValue(pendingRow());

      await service.triage(
        'partner-1',
        'reject',
        'Overlaps an existing partner',
        'admin-1',
      );

      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith({
        recipientId: 'submitter-1',
        kind: SubmissionKind.PartnerApplication,
        // `Declined`, never `Archived`: a human in the triage console read this
        // and said no.
        outcome: SubmissionOutcome.Declined,
        subjectLabel: 'ILGA Portugal',
        reviewNote: 'Overlaps an existing partner',
      });
    });

    it('does not attach an old refusal note to an approval', async () => {
      // `triage` never clears `reviewNote`, so approving on a second pass would
      // otherwise mail the earlier refusal out with the good news.
      partners.findOne.mockResolvedValue(
        pendingRow({
          status: PartnerStatus.Rejected,
          reviewNote: 'Overlaps an existing partner',
          decidedAt: new Date('2026-01-09T12:00:00.000Z'),
        }),
      );

      await service.triage('partner-1', 'approve', undefined, 'admin-1');

      expect(submissionDecisions.notifyDecided).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: SubmissionOutcome.Accepted,
          reviewNote: null,
        }),
      );
    });

    it('stays silent when the status is set to what it already was', async () => {
      partners.findOne.mockResolvedValue(
        pendingRow({
          status: PartnerStatus.Approved,
          decidedAt: new Date('2026-01-09T12:00:00.000Z'),
        }),
      );

      await service.triage('partner-1', 'approve', undefined, 'admin-1');

      // A double-click, a retried request or a re-triage of a settled row must
      // not tell the same organisation twice.
      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('stays silent when a rejection note is corrected on an already-rejected row', async () => {
      partners.findOne.mockResolvedValue(
        pendingRow({
          status: PartnerStatus.Rejected,
          reviewNote: 'Typo in the first note',
          decidedAt: new Date('2026-01-09T12:00:00.000Z'),
        }),
      );

      await service.triage(
        'partner-1',
        'reject',
        'Overlaps an existing partner',
        'admin-1',
      );

      expect(partners.save).toHaveBeenCalled();
      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('does not notify an admin who decided their own application', async () => {
      partners.findOne.mockResolvedValue(
        pendingRow({ submittedById: 'admin-1' }),
      );

      await service.triage('partner-1', 'approve', undefined, 'admin-1');

      expect(submissionDecisions.notifyDecided).not.toHaveBeenCalled();
    });

    it('still commits the decision when the notification throws', async () => {
      partners.findOne.mockResolvedValue(pendingRow());
      submissionDecisions.notifyDecided.mockRejectedValue(
        new Error('notifications are down'),
      );

      // The decision already committed. It must not be rolled back, and the
      // admin must not see an error, because the bell failed.
      const result = await service.triage(
        'partner-1',
        'approve',
        undefined,
        'admin-1',
      );

      expect(result.status).toBe(PartnerStatus.Approved);
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PartnerStatus.Approved }),
      );
    });
  });

  describe('updateAdminFields', () => {
    it('404s an unknown id', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(
        service.updateAdminFields('nope', { featured: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sets featured and saves', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        submittedById: 'submitter-1',
        featured: false,
        testimonialQuote: null,
        testimonialAuthor: null,
        testimonialRole: null,
      });

      const res = await service.updateAdminFields('partner-1', {
        featured: true,
      });

      expect(res.featured).toBe(true);
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({ featured: true }),
      );
    });

    it('sets a full testimonial (quote + author + role) and saves', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        submittedById: 'submitter-1',
        featured: false,
        testimonialQuote: null,
        testimonialAuthor: null,
        testimonialRole: null,
      });

      const res = await service.updateAdminFields('partner-1', {
        testimonialQuote: 'They showed up when no one else did.',
        testimonialAuthor: 'Marta Silva',
        testimonialRole: 'Community organizer',
      });

      expect(res.testimonialQuote).toBe('They showed up when no one else did.');
      expect(res.testimonialAuthor).toBe('Marta Silva');
      expect(res.testimonialRole).toBe('Community organizer');
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          testimonialQuote: 'They showed up when no one else did.',
          testimonialAuthor: 'Marta Silva',
          testimonialRole: 'Community organizer',
        }),
      );
    });

    it('clears the testimonial when all three fields are passed as null', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        submittedById: 'submitter-1',
        featured: true,
        testimonialQuote: 'They showed up when no one else did.',
        testimonialAuthor: 'Marta Silva',
        testimonialRole: 'Community organizer',
      });

      const res = await service.updateAdminFields('partner-1', {
        testimonialQuote: null,
        testimonialAuthor: null,
        testimonialRole: null,
      });

      expect(res.testimonialQuote).toBeNull();
      expect(res.testimonialAuthor).toBeNull();
      expect(res.testimonialRole).toBeNull();
      expect(partners.save).toHaveBeenCalledWith(
        expect.objectContaining({
          testimonialQuote: null,
          testimonialAuthor: null,
          testimonialRole: null,
        }),
      );
    });

    it('throws ConflictException when a quote is set without an author', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        submittedById: 'submitter-1',
        featured: false,
        testimonialQuote: null,
        testimonialAuthor: null,
        testimonialRole: null,
      });

      await expect(
        service.updateAdminFields('partner-1', {
          testimonialQuote: 'They showed up when no one else did.',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('idBySlug / refsByIds', () => {
    it('resolves any partner regardless of status', async () => {
      partners.findOne.mockResolvedValue({
        id: 'partner-1',
        status: PartnerStatus.Pending,
      });
      await expect(service.idBySlug('some-partner')).resolves.toBe('partner-1');
    });

    it('returns null for an unknown slug', async () => {
      partners.findOne.mockResolvedValue(null);
      await expect(service.idBySlug('nope')).resolves.toBeNull();
    });

    it('batches id -> {slug,name} refs', async () => {
      partners.find.mockResolvedValue([
        { id: 'partner-1', slug: 'ilga-portugal', name: 'ILGA Portugal' },
      ]);
      const refs = await service.refsByIds(['partner-1']);
      expect(refs.get('partner-1')).toEqual({
        slug: 'ilga-portugal',
        name: 'ILGA Portugal',
      });
    });

    it('short-circuits an empty id list without querying', async () => {
      const refs = await service.refsByIds([]);
      expect(refs.size).toBe(0);
      expect(partners.find).not.toHaveBeenCalled();
    });
  });
});
