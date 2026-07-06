import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CompaniesService,
  CreateCompanyInput,
} from '../companies/companies.service';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
import {
  JobApplication,
  JobApplicationAnswer,
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
  toJobApplication,
  toJobCard,
  toJobDetail,
} from './job-response';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s identical
// file-local helper (not shared/exported, kept consistent with that
// precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

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
    // Circular: `CompaniesService.getOpenRoles` calls back into
    // `JobsService.listOpenForCompany`. Both modules already wrap each
    // other's import in `forwardRef()` (see `companies.module.ts` /
    // `jobs.module.ts`); this constructor injection needs the same
    // `forwardRef()` treatment because the two *providers* — not just the
    // two modules — depend on each other directly.
    @Inject(forwardRef(() => CompaniesService))
    private readonly companiesService: CompaniesService,
  ) {}

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

  async list(query: JobListQuery): Promise<Paginated<JobCardDTO>> {
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

  async getBySlug(slug: string, viewerId: string): Promise<JobDetailDTO> {
    const job = await this.loadOr404(slug);
    return this.buildDetail(job, viewerId);
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

  // What `CompaniesService.getOpenRoles` delegates to for
  // `CompanyDetailDTO.openRoles` / `CompanyCardDTO.openRolesCount`. The
  // single-`companyId` signature is fixed by the spec, so this resolves the
  // company's own ref via `CompaniesService.companyRefsByIds` itself rather
  // than requiring the (already-in-hand, on the caller's side) ref to be
  // passed in — a minor redundant lookup traded for the simpler signature.
  async listOpenForCompany(companyId: string): Promise<JobCardDTO[]> {
    const rows = await this.jobs.find({
      where: { companyId, status: JobStatus.Open },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];
    const companyRefs = await this.companiesService.companyRefsByIds([
      companyId,
    ]);
    const ref = companyRefs.get(companyId) ?? null;
    return rows.map((j) => toJobCard(j, ref));
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

    try {
      const saved = await this.applications.save(
        this.applications.create({
          jobId: job.id,
          applicantId,
          answers: dto.answers,
          coverNote: dto.coverNote ?? null,
        }),
      );
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

    const rows = await this.applications.find({
      where: { jobId: job.id },
      order: { createdAt: 'DESC' },
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
      this.profiles.findOne({ where: { userId: job.posterId } }),
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
