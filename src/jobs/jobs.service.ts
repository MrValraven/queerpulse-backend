import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { UserRole } from '../users/entities/user.entity';
import {
  CompaniesService,
  CreateCompanyInput,
} from '../companies/companies.service';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  JobApplication,
  JobApplicationAnswer,
  JobApplicationStatus,
} from './entities/job-application.entity';
import {
  Job,
  JobDetailBody,
  JobFormat,
  JobStatus,
} from './entities/job.entity';
import {
  JobApplicationDTO,
  JobCardDTO,
  JobDetailDTO,
  JobSearchRow,
  toJobApplication,
  toJobCard,
  toJobDetail,
  toJobSearchRow,
} from './job-response';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s identical
// file-local helper (not shared/exported, kept consistent with that
// precedent).
export interface CreateJobInput {
  title: string;
  category: string;
  commitment: string;
  seniority: string;
  format: JobFormat;
  location: string;
  city?: string;
  timezone?: string;
  description: string; // -> `desc`
  deadline?: string;
  startDate?: string;
  salary?: string;
  rateMin?: number;
  rateMax?: number;
  currency?: string;
  ratePer?: string;
  hidePay?: boolean;
  barter?: boolean;
  benefits?: string[];
  inclusivity?: string[];
  tags?: string[];
  screening?: string[];
  contacts?: string[];
  email?: string;
  link?: string;
  detail?: Partial<JobDetailBody>;
  queerRun?: boolean;
  qrLabel?: string;
  // Existing company (poster must own it or be on its team) — mutually
  // exclusive with `company` (inline-create).
  companySlug?: string;
  company?: CreateCompanyInput;
  // `agreement` is intentionally excluded here — it's a client-side consent
  // gate fully enforced by `CreateJobDto`'s `@Equals(true)`; the service
  // never reads it (mirrors `CreateCompanyInput` never carrying `verified`).
}

// `companySlug`/`company` only ever apply at creation time — a job's
// company/poster affiliation is fixed once created, so `update()` never
// reads either even though `UpdateJobDto` carries them (mirrors
// `UpdateCompanyDto`'s identical "handle/team ignored on patch" precedent).
export type UpdateJobInput = Partial<
  Omit<CreateJobInput, 'companySlug' | 'company'>
>;

export interface JobListQuery {
  cat?: string;
  type?: string;
  page?: number;
}

export interface CreateJobApplicationInput {
  answers: JobApplicationAnswer[];
  coverNote?: string;
}

// A job is reported (and taken down) under the `job` subject, keyed by the job
// slug — matching the report control on the job detail page
// (`subjectType="job"`, `subjectId={job.slug}`) and what the shared
// `content_moderation` row therefore stores.
const JOB_SUBJECT_TYPE = 'job';

// Platform staff (moderator/admin) still see moderator-taken-down jobs on the
// read paths; ordinary members don't. Mirrors `ForumPostsService`'s
// `MODERATOR_ROLES` / `isModeratorRole`.
const STAFF_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];

function isStaffRole(role: string | undefined): boolean {
  return role != null && STAFF_ROLES.includes(role);
}

/** Fills every `JobDetailBody` subfield so the `jsonb NOT NULL` `detail`
 * column is always fully populated, even when a caller only supplies part
 * of it (or omits it entirely at creation). */
function normalizeDetail(detail?: Partial<JobDetailBody>): JobDetailBody {
  return {
    about: detail?.about ?? [],
    dayToDay: detail?.dayToDay ?? [],
    lookingFor: detail?.lookingFor ?? [],
    offer: detail?.offer ?? [],
    reviewerNote: detail?.reviewerNote ?? null,
  };
}

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly applications: Repository<JobApplication>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // Resolve/authorize a company for job posting, create one inline, and
    // batch-resolve company refs for job cards. This is now a one-directional
    // dependency: `CompaniesService` no longer injects `JobsService` (it reads
    // open roles through `CompanyOpenRolesService` instead), so no `forwardRef`
    // is needed on either side.
    private readonly companiesService: CompaniesService,
    private readonly notifications: NotificationsService,
    // Delivers the poster's decision on an application to the applicant
    // (`decideApplication`, BE-HSG-16). There is no applicant-facing job
    // NotificationType, and a DM gives them somewhere to reply.
    private readonly messaging: MessagingService,
    // Reads the shared `content_moderation` state so a moderator takedown on a
    // `job` subject withholds the job from ordinary members' read paths.
    private readonly contentModeration: ContentModerationService,
  ) {}

  // Drops any job under a `job` takedown (hidden OR removed) from a job query
  // builder, in-query so pagination/counts stay consistent — the same reason
  // `DirectoryService.excludeModeratedListings` and
  // `ContentModerationService.excludeHidden` filter in-query rather than after a
  // fixed-size fetch. A job is NOT rendered as a tombstone the way a forum post
  // is, so BOTH hidden and removed are excluded here; staff read paths skip this
  // call and still see takedowns. The `j.slug` reference is spliced verbatim
  // into raw SQL (never user input); it is cast to text because
  // `content_moderation.subject_id` is varchar while `jobs.slug` is varchar too
  // (no cast needed — both varchar), keyed on the unique
  // `(subject_type, subject_id)` index.
  private excludeModeratedJobs(qb: SelectQueryBuilder<Job>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cmj"
        WHERE "cmj"."subject_type" = :jobSubjectType
          AND "cmj"."subject_id" = j.slug
          AND ("cmj"."hidden_at" IS NOT NULL OR "cmj"."removed_at" IS NOT NULL)
      )`,
      { jobSubjectType: JOB_SUBJECT_TYPE },
    );
  }

  async create(posterId: string, dto: CreateJobInput): Promise<JobDetailDTO> {
    const companyRef = await this.resolveCompanyForCreate(posterId, dto);
    const job = await this.createWithUniqueSlug(posterId, companyRef.id, dto);
    return this.buildDetail(job, posterId);
  }

  // Resolves `companySlug` (existing company; `CompaniesService` throws
  // Forbidden if `posterId` isn't the owner or on the team) or `company`
  // (inline-create, poster becomes owner). Exactly one of the two must be
  // present — the spec's DTO comment says "companySlug ... or company" but
  // doesn't cover neither being sent, so a `BadRequestException` here is an
  // explicit assumption, not spec text.
  private async resolveCompanyForCreate(
    posterId: string,
    dto: CreateJobInput,
  ): Promise<{ id: string; slug: string; nameText: string }> {
    if (dto.companySlug) {
      const ref = await this.companiesService.getCompanyForJobPosting(
        dto.companySlug,
        posterId,
      );
      if (!ref) {
        throw new NotFoundException('Company not found');
      }
      return ref;
    }

    if (dto.company) {
      const created = await this.companiesService.create(posterId, dto.company);
      const ref = await this.companiesService.getCompanyForJobPosting(
        created.slug,
        posterId,
      );
      if (!ref) {
        // Unreachable in practice: `posterId` just created this company as
        // its owner, so it must resolve as affiliated.
        throw new NotFoundException('Company not found');
      }
      return ref;
    }

    throw new BadRequestException(
      'Provide either an existing companySlug or an inline company to create',
    );
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a
  // concurrent create; the unique index on `slug` is the real backstop and
  // turns that race into a 23505, which forces a fresh slug + retry (mirrors
  // `CompaniesService.createWithUniqueSlug`).
  private async createWithUniqueSlug(
    posterId: string,
    companyId: string,
    dto: CreateJobInput,
  ): Promise<Job> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(slugify(dto.title, 'job'), (s) =>
        this.jobs.exists({ where: { slug: s } }),
      );

      try {
        return await this.jobs.save(
          this.jobs.create({
            slug,
            companyId,
            title: dto.title,
            category: dto.category,
            commitment: dto.commitment,
            seniority: dto.seniority,
            format: dto.format,
            location: dto.location,
            city: dto.city ?? null,
            timezone: dto.timezone ?? null,
            salary: dto.salary ?? null,
            rateMin: dto.rateMin ?? null,
            rateMax: dto.rateMax ?? null,
            currency: dto.currency ?? null,
            ratePer: dto.ratePer ?? null,
            hidePay: dto.hidePay ?? false,
            barter: dto.barter ?? false,
            deadline: dto.deadline ?? null,
            startDate: dto.startDate ?? null,
            desc: dto.description,
            tags: dto.tags ?? [],
            queerRun: dto.queerRun ?? false,
            qrLabel: dto.qrLabel ?? null,
            detail: normalizeDetail(dto.detail),
            benefits: dto.benefits ?? [],
            inclusivity: dto.inclusivity ?? [],
            screening: dto.screening ?? [],
            contacts: dto.contacts ?? [],
            email: dto.email ?? null,
            link: dto.link ?? null,
            posterId,
            status: JobStatus.Open,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            continue;
          }
          throw new ConflictException('Could not allocate a unique job slug');
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved job or throws above.
    throw new ConflictException('Could not allocate a unique job slug');
  }

  // Public/member job grid (`GET /jobs`). `viewerRole` gates the moderation
  // filter: ordinary members never see a taken-down job, platform staff still
  // do (so the grid a moderator sees matches what they can act on).
  async list(
    query: JobListQuery,
    viewerRole?: string,
  ): Promise<Paginated<JobCardDTO>> {
    return this.listInternal(query, {
      excludeModerated: !isStaffRole(viewerRole),
    });
  }

  // Owner's own postings — backs `GET /me/jobs`. Reuses the same
  // `JobListQuery`/`Paginated<JobCardDTO>` shape as `list()`, just scoped to
  // `posterId` (mirrors `listMyApplications`'s "me" precedent, but keeps
  // page-number pagination since this is a card list, not a feed). Moderation
  // filtering is deliberately NOT applied: a takedown only withholds a job from
  // the public grid/detail — the poster still manages their own job here,
  // mirroring `DirectoryService`'s "owner routes don't go through the filtered
  // public read" contract.
  async listMine(
    posterId: string,
    query: JobListQuery,
  ): Promise<Paginated<JobCardDTO>> {
    return this.listInternal(query, { posterId, excludeModerated: false });
  }

  private async listInternal(
    query: JobListQuery,
    opts: { posterId?: string; excludeModerated: boolean },
  ): Promise<Paginated<JobCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.jobs
      .createQueryBuilder('j')
      .orderBy('j.created_at', 'DESC');

    if (query.cat) {
      qb.andWhere('j.category = :cat', { cat: query.cat });
    }
    if (query.type) {
      qb.andWhere('j.commitment = :type', { type: query.type });
    }
    if (opts.posterId) {
      qb.andWhere('j.poster_id = :posterId', { posterId: opts.posterId });
    }
    if (opts.excludeModerated) {
      this.excludeModeratedJobs(qb);
    }

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const companyIds = [...new Set(rows.map((j) => j.companyId))];
      const companyRefs =
        await this.companiesService.companyRefsByIds(companyIds);
      return rows.map((j) =>
        toJobCard(j, companyRefs.get(j.companyId) ?? null),
      );
    });
  }

  async getBySlug(
    slug: string,
    viewerId: string,
    viewerRole?: string,
  ): Promise<JobDetailDTO> {
    const job = await this.loadOr404(slug);
    // A moderator takedown (hidden OR removed) withholds the job's detail from
    // ordinary members — it 404s exactly as an unknown slug does, so the
    // takedown isn't even confirmable. Platform staff and the job's own poster
    // are exempt: staff act on it, the poster still manages it (and still sees
    // it in `listMine`). A removed job is withheld here rather than blanked —
    // jobs have no tombstone rendering, unlike forum/community posts.
    if (!isStaffRole(viewerRole) && job.posterId !== viewerId) {
      const state = await this.contentModeration.stateFor(
        JOB_SUBJECT_TYPE,
        job.slug,
      );
      if (state.hidden || state.removed) {
        throw new NotFoundException('Job not found');
      }
    }
    return this.buildDetail(job, viewerId);
  }

  // Cross-entity global search (SearchService) — open postings only, ILIKE
  // over title / desc. No company/poster hydration: the search row needs only
  // slug / title / category / location.
  async searchByText(term: string, limit: number): Promise<JobSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const qb = this.jobs
      .createQueryBuilder('j')
      .where('j.status = :open', { open: JobStatus.Open })
      .andWhere('(j.title ILIKE :pattern OR j.desc ILIKE :pattern)', {
        pattern,
      });
    // Global search is a cross-entity discovery surface with no per-viewer staff
    // role — a taken-down job must never resurface here for anyone.
    this.excludeModeratedJobs(qb);
    const rows = await qb.orderBy('j.created_at', 'DESC').take(limit).getMany();
    return rows.map(toJobSearchRow);
  }

  async update(
    slug: string,
    posterId: string,
    dto: UpdateJobInput,
  ): Promise<JobDetailDTO> {
    const job = await this.loadOr404(slug);
    if (job.posterId !== posterId) {
      throw new ForbiddenException('Only the poster can update this job');
    }

    Object.assign(job, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.commitment !== undefined ? { commitment: dto.commitment } : {}),
      ...(dto.seniority !== undefined ? { seniority: dto.seniority } : {}),
      ...(dto.format !== undefined ? { format: dto.format } : {}),
      ...(dto.location !== undefined ? { location: dto.location } : {}),
      ...(dto.city !== undefined ? { city: dto.city ?? null } : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone ?? null } : {}),
      ...(dto.description !== undefined ? { desc: dto.description } : {}),
      ...(dto.deadline !== undefined ? { deadline: dto.deadline ?? null } : {}),
      ...(dto.startDate !== undefined
        ? { startDate: dto.startDate ?? null }
        : {}),
      ...(dto.salary !== undefined ? { salary: dto.salary ?? null } : {}),
      ...(dto.rateMin !== undefined ? { rateMin: dto.rateMin ?? null } : {}),
      ...(dto.rateMax !== undefined ? { rateMax: dto.rateMax ?? null } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency ?? null } : {}),
      ...(dto.ratePer !== undefined ? { ratePer: dto.ratePer ?? null } : {}),
      ...(dto.hidePay !== undefined ? { hidePay: dto.hidePay } : {}),
      ...(dto.barter !== undefined ? { barter: dto.barter } : {}),
      ...(dto.benefits !== undefined ? { benefits: dto.benefits } : {}),
      ...(dto.inclusivity !== undefined
        ? { inclusivity: dto.inclusivity }
        : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.screening !== undefined ? { screening: dto.screening } : {}),
      ...(dto.contacts !== undefined ? { contacts: dto.contacts } : {}),
      ...(dto.email !== undefined ? { email: dto.email ?? null } : {}),
      ...(dto.link !== undefined ? { link: dto.link ?? null } : {}),
      ...(dto.detail !== undefined
        ? { detail: normalizeDetail(dto.detail) }
        : {}),
      ...(dto.queerRun !== undefined ? { queerRun: dto.queerRun } : {}),
      ...(dto.qrLabel !== undefined ? { qrLabel: dto.qrLabel ?? null } : {}),
    });

    const saved = await this.jobs.save(job);
    return this.buildDetail(saved, posterId);
  }

  // Idempotent: re-closing an already-closed job just re-saves the same
  // status (mirrors `EventsService.cancel`'s terminal-state precedent).
  async close(slug: string, posterId: string): Promise<JobDetailDTO> {
    const job = await this.loadOr404(slug);
    if (job.posterId !== posterId) {
      throw new ForbiddenException('Only the poster can close this job');
    }
    job.status = JobStatus.Closed;
    const saved = await this.jobs.save(job);
    return this.buildDetail(saved, posterId);
  }

  // UNIQUE per (job, applicant) — a repeat application surfaces as 23505,
  // mapped to Conflict rather than a 500 (mirrors
  // `CompaniesService.createReview`'s identical 23505 -> Conflict mapping).
  async apply(
    slug: string,
    applicantId: string,
    dto: CreateJobApplicationInput,
  ): Promise<JobApplicationDTO> {
    const job = await this.loadOr404(slug);
    // BE-HSG-16: a closed role stops taking applications. `apply()` used to
    // insert regardless of `job.status`, so an applicant could submit into a
    // role nobody was reading any more and would simply never hear back.
    if (job.status !== JobStatus.Open) {
      throw new ConflictException('This role is closed to new applications');
    }

    try {
      const saved = await this.applications.save(
        this.applications.create({
          jobId: job.id,
          applicantId,
          answers: dto.answers,
          coverNote: dto.coverNote ?? null,
        }),
      );
      // Tell the poster they have an applicant (skip self — a poster applying
      // to their own posting notifies no one). Best-effort: an application must
      // never fail because its notification did.
      // A NULL `posterId` is a role whose poster erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`); there is nobody
      // left to notify. `ContentOwnerErasureService` closes such roles on
      // erasure, so this is only reachable for a role reopened by a moderator.
      if (job.posterId !== null && job.posterId !== applicantId) {
        try {
          await this.notifications.create(
            job.posterId,
            NotificationType.JobApplication,
            {
              actorId: applicantId,
              source: 'job',
              jobSlug: job.slug,
              jobTitle: job.title,
            },
            applicantId,
          );
        } catch {
          // Intentionally ignored — the application already committed.
        }
      }
      const applicant = await this.memberRefFor(applicantId);
      return toJobApplication(
        saved,
        { slug: job.slug, title: job.title },
        applicant,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('You have already applied to this job');
      }
      throw err;
    }
  }

  /**
   * The poster moves one application out of `submitted` (BE-HSG-16).
   *
   * `JobApplicationStatus` has carried `reviewing`/`accepted`/`declined` since
   * the table was created, but nothing in the codebase ever wrote them outside
   * the seed: there was no route and no service method, so `status` was
   * permanently `submitted` for everyone while `JobApplicationDTO.status` and
   * `myApplicationStatus` presented it to both sides as if it were live. The
   * poster had a list of applicants they could not act on, and the applicant
   * never heard anything.
   *
   * Mirrors `VolunteeringService.decideSignup` on the sibling domain: poster
   * gated, one conditional UPDATE so two concurrent decisions cannot both win,
   * and a best-effort message to the applicant after it commits.
   */
  async decideApplication(
    slug: string,
    applicationId: string,
    posterId: string,
    status:
      | JobApplicationStatus.Reviewing
      | JobApplicationStatus.Accepted
      | JobApplicationStatus.Declined,
  ): Promise<JobApplicationDTO> {
    const job = await this.loadOr404(slug);
    if (job.posterId !== posterId) {
      throw new ForbiddenException(
        'Only the poster can decide on applications for this job',
      );
    }

    const application = await this.applications.findOne({
      where: { id: applicationId, jobId: job.id },
    });
    if (!application) {
      throw new NotFoundException('Application not found');
    }
    // A decision is final in one direction: an already-decided application is
    // not re-openable, and `reviewing` is an intermediate the poster can only
    // move INTO from `submitted`.
    const decidable: JobApplicationStatus[] =
      status === JobApplicationStatus.Reviewing
        ? [JobApplicationStatus.Submitted]
        : [JobApplicationStatus.Submitted, JobApplicationStatus.Reviewing];
    if (!decidable.includes(application.status)) {
      throw new ConflictException('This application was already decided');
    }

    // Conditional UPDATE on the status we just read: a concurrent second
    // decision sees `affected === 0` and is rejected rather than silently
    // overwriting the first.
    const claim = await this.applications
      .createQueryBuilder()
      .update(JobApplication)
      .set({ status })
      .where('id = :id AND status IN (:...decidable)', {
        id: application.id,
        decidable,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('This application was already decided');
    }
    application.status = status;

    const applicant = await this.memberRefFor(application.applicantId);
    // The applicant is told, unless they are the poster (a poster can apply to
    // their own posting, and messaging yourself is not a thing). Best-effort and
    // post-commit: the decision has already landed.
    //
    // Delivered as a DM from the poster rather than a bell notification because
    // there is no applicant-facing job-decision `NotificationType`, and adding
    // one is a change to the notifications domain. A DM is arguably the better
    // channel anyway: it gives the applicant somewhere to reply.
    if (application.applicantId !== posterId) {
      await this.notifyApplicantBestEffort(posterId, application, job, status);
    }

    return toJobApplication(
      application,
      { slug: job.slug, title: job.title },
      applicant,
    );
  }

  /** Best-effort DM to an applicant whose application was just decided. Never
   * throws: the decision committed before this ran. */
  private async notifyApplicantBestEffort(
    posterId: string,
    application: JobApplication,
    job: Job,
    status: JobApplicationStatus,
  ): Promise<void> {
    const body =
      status === JobApplicationStatus.Accepted
        ? `Good news about your application for "${job.title}": it has been accepted. Reply here and we can take it from there.`
        : status === JobApplicationStatus.Declined
          ? `Thank you for applying for "${job.title}". We are not taking this one forward, but we appreciate the time you put into it.`
          : `Your application for "${job.title}" is being reviewed. We will come back to you once there is news.`;
    try {
      await this.messaging.deliverEnquiry(
        posterId,
        application.applicantId,
        body,
      );
    } catch {
      // Intentionally ignored — the decision already committed.
    }
  }

  async listApplications(
    slug: string,
    posterId: string,
  ): Promise<JobApplicationDTO[]> {
    const job = await this.loadOr404(slug);
    if (job.posterId !== posterId) {
      throw new ForbiddenException(
        'Only the poster can view applications for this job',
      );
    }

    // Bounded: a popular posting can carry thousands of applications, each
    // with a full `answers` jsonb blob, and this had no `take` at all.
    const rows = await this.applications.find({
      where: { jobId: job.id },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((a) => a.applicantId),
    );
    return rows.map((a) =>
      toJobApplication(
        a,
        { slug: job.slug, title: job.title },
        refs.get(a.applicantId) ?? null,
      ),
    );
  }

  async listMyApplications(applicantId: string): Promise<JobApplicationDTO[]> {
    const rows = await this.applications.find({
      where: { applicantId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const jobIds = [...new Set(rows.map((a) => a.jobId))];
    const [jobRows, applicant] = await Promise.all([
      this.jobs.find({ where: { id: In(jobIds) } }),
      this.memberRefFor(applicantId),
    ]);
    const jobById = new Map(jobRows.map((j) => [j.id, j]));

    return rows.map((a) => {
      const job = jobById.get(a.jobId);
      if (!job) {
        // FK (`job_applications.job_id` -> `jobs.id`, ON DELETE CASCADE)
        // means an application row can't outlive its job — a miss here
        // would be a data-integrity bug, not a legitimate empty state.
        throw new NotFoundException('Job not found for application');
      }
      return toJobApplication(
        a,
        { slug: job.slug, title: job.title },
        applicant,
      );
    });
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Job> {
    const job = await this.jobs.findOne({ where: { slug } });
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  // Resolves a single userId to a MemberRef for an actor who just
  // created/owns a row (a miss here would mean a data-integrity bug — an
  // authenticated member without a profile — not a legitimate empty state).
  // Mirrors `CompaniesService.memberRefFor`.
  private async memberRefFor(userId: string): Promise<MemberRef> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    const ref = refs.get(userId);
    if (!ref) {
      throw new NotFoundException('Member profile not found');
    }
    return ref;
  }

  private async buildDetail(job: Job, viewerId: string): Promise<JobDetailDTO> {
    const [companyRefs, posterProfile, myApplication] = await Promise.all([
      this.companiesService.companyRefsByIds([job.companyId]),
      job.posterId === null
        ? null
        : this.profiles.findOne({ where: { userId: job.posterId } }),
      this.applications.findOne({
        where: { jobId: job.id, applicantId: viewerId },
      }),
    ]);

    return toJobDetail(
      job,
      companyRefs.get(job.companyId) ?? null,
      toMemberRef(posterProfile),
      job.posterId === viewerId,
      myApplication?.status ?? null,
    );
  }
}
