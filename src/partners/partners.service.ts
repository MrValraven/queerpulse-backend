import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
import {
  PartnerApplicationDTO,
  PartnerCardDTO,
  PartnerDetailDTO,
  toPartnerApplication,
  toPartnerCard,
  toPartnerDetail,
} from './partner-response';
import {
  Partner,
  PartnerAtGlance,
  PartnerContact,
  PartnerJointWork,
  PartnerRegion,
  PartnerSection,
  PartnerStat,
  PartnerStatus,
  PartnerTimelineItem,
} from './entities/partner.entity';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `VolunteeringService`'s identical file-local helper (not shared/exported,
// kept consistent with that precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

/** `CreatePartnerApplicationDto.contact`'s shape at the service boundary —
 * every subfield optional on input, always normalized to `PartnerContact`
 * (`string | null`, never omitted) before it's persisted. */
export interface PartnerContactInput {
  phone?: string;
  phoneNote?: string;
  email?: string;
  website?: string;
  address?: string;
}

export interface CreatePartnerApplicationInput {
  name: string;
  logo: string;
  region: PartnerRegion;
  regionLabel: string;
  city: string;
  desc: string;
  tags?: string[];
  tier: string;
  since: string;
  eyebrow: string;
  tagline: string;
  about?: string[];
  stats?: PartnerStat[];
  aboutMore?: PartnerSection[];
  jointWork?: PartnerJointWork[];
  timeline?: PartnerTimelineItem[];
  how?: PartnerSection[];
  funding?: string;
  atGlance?: PartnerAtGlance[];
  contact?: PartnerContactInput;
  // Desired slug; `createWithUniqueSlug` slugifies + de-dupes it, defaulting
  // to `name` when omitted (mirrors `CreateCompanyInput.handle`).
  handle?: string;
}

export interface PartnerListQuery {
  region?: PartnerRegion;
  page?: number;
  featured?: boolean;
}

export interface UpdatePartnerAdminInput {
  featured?: boolean;
  testimonialQuote?: string | null;
  testimonialAuthor?: string | null;
  testimonialRole?: string | null;
}

/** Bridges `PartnerContactInput`'s optional subfields to the entity column's
 * fully-populated `string | null` shape (mirrors `CompaniesService`'s
 * `normalizeWork`/`VolunteeringService`'s `normalizeDetail`). */
function normalizeContact(contact?: PartnerContactInput): PartnerContact {
  return {
    phone: contact?.phone ?? null,
    phoneNote: contact?.phoneNote ?? null,
    email: contact?.email ?? null,
    website: contact?.website ?? null,
    address: contact?.address ?? null,
  };
}

@Injectable()
export class PartnersService {
  constructor(
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  // Public directory: approved partners only, optionally filtered by region.
  async list(query: PartnerListQuery): Promise<Paginated<PartnerCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.partners
      .createQueryBuilder('p')
      .where('p.status = :status', { status: PartnerStatus.Approved })
      .orderBy('p.created_at', 'DESC');

    if (query.region) {
      qb.andWhere('p.region = :region', { region: query.region });
    }

    if (query.featured) {
      qb.andWhere('p.featured = :featured', { featured: true });
    }

    return paginate(qb, page, (rows) => rows.map(toPartnerCard));
  }

  // 404s for anything non-approved — hides pending/rejected partners'
  // existence from the public rather than surfacing a distinct "not visible
  // yet" response (mirrors the spec's "404 for non-approved to the public").
  async getBySlug(slug: string): Promise<PartnerDetailDTO> {
    const partner = await this.partners.findOne({ where: { slug } });
    if (!partner || partner.status !== PartnerStatus.Approved) {
      throw new NotFoundException('Partner not found');
    }
    return toPartnerDetail(partner);
  }

  async submitApplication(
    memberId: string,
    dto: CreatePartnerApplicationInput,
  ): Promise<PartnerApplicationDTO> {
    const saved = await this.createWithUniqueSlug(memberId, dto);
    return this.buildApplication(saved);
  }

  // Admin queue: pending applications awaiting triage.
  async listApplications(): Promise<PartnerApplicationDTO[]> {
    const rows = await this.partners.find({
      where: { status: PartnerStatus.Pending },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];
    return this.buildApplications(rows);
  }

  // `approve` publishes the partner into the public directory; `reject`
  // records the admin's `note` as `reviewNote`. Mirrors the spec's endpoint
  // table verbatim: approve only flips `status`, reject flips `status` AND
  // sets `reviewNote` — an approval note isn't part of the contract.
  async triage(
    id: string,
    action: 'approve' | 'reject',
    note?: string,
  ): Promise<PartnerApplicationDTO> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner) {
      throw new NotFoundException('Partner application not found');
    }

    if (action === 'approve') {
      partner.status = PartnerStatus.Approved;
    } else {
      partner.status = PartnerStatus.Rejected;
      partner.reviewNote = note ?? null;
    }

    const saved = await this.partners.save(partner);
    return this.buildApplication(saved);
  }

  // Admin edit of an approved partner's featured flag + testimonial. Only the
  // provided fields change (PATCH). A quote with no author is rejected — the
  // For Organisations card renders "<quote> — <author>, <role>" and a
  // dangling quote would print an orphaned em-dash.
  async updateAdminFields(
    id: string,
    dto: UpdatePartnerAdminInput,
  ): Promise<PartnerApplicationDTO> {
    const partner = await this.partners.findOne({ where: { id } });
    if (!partner) {
      throw new NotFoundException('Partner not found');
    }

    if (dto.featured !== undefined) partner.featured = dto.featured;
    if (dto.testimonialQuote !== undefined)
      partner.testimonialQuote = dto.testimonialQuote;
    if (dto.testimonialAuthor !== undefined)
      partner.testimonialAuthor = dto.testimonialAuthor;
    if (dto.testimonialRole !== undefined)
      partner.testimonialRole = dto.testimonialRole;

    if (partner.testimonialQuote && !partner.testimonialAuthor) {
      throw new ConflictException('A testimonial quote requires an author');
    }

    const saved = await this.partners.save(partner);
    return this.buildApplication(saved);
  }

  // --- cross-domain accessors for VolunteeringService ---
  // `VolunteeringModule` never registers its own `Partner` repository (mirrors
  // `JobsModule` never registering `Company`/`CompanyTeamMember` — see
  // `.superpowers/sdd/spec-phaseB-companies-jobs.md`), so it reaches partner
  // data only through these two methods on the already-imported
  // `PartnersService`.

  /**
   * Resolves ANY partner (regardless of `status`) by slug to its id — used by
   * `VolunteeringService` to link an opportunity to a partner org. Unlike the
   * public `getBySlug`, this doesn't gate on `status === approved`: an
   * opportunity poster may reference a partner application that hasn't been
   * reviewed yet. Returns `null` for an unknown slug (never throws — the
   * caller treats "unresolved" the same as "no partner").
   */
  async idBySlug(slug: string): Promise<string | null> {
    const partner = await this.partners.findOne({ where: { slug } });
    return partner?.id ?? null;
  }

  /**
   * Batched partner-id -> `{slug,name}` ref lookup (mirrors
   * `CompaniesService.companyRefsByIds`'s shape) for `VolunteeringService`'s
   * list/detail views, so a page of opportunity cards resolves every
   * embedded partner ref in one query instead of N+1. Not status-gated, for
   * the same reason as `idBySlug`.
   */
  async refsByIds(
    ids: string[],
  ): Promise<Map<string, { slug: string; name: string }>> {
    const map = new Map<string, { slug: string; name: string }>();
    if (!ids.length) return map;

    const rows = await this.partners.find({
      where: { id: In(ids) },
      select: ['id', 'slug', 'name'],
    });
    for (const row of rows) {
      map.set(row.id, { slug: row.slug, name: row.name });
    }
    return map;
  }

  // --- internals ---

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // submission landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505, forcing a
  // retry with a freshly recomputed slug (mirrors
  // `CompaniesService.createWithUniqueSlug`/
  // `VolunteeringService.createWithUniqueSlug`). No child rows are seeded
  // alongside a partner (unlike companies' team / volunteering's team), so
  // there's no need for `DataSource.transaction` here — a single `save()`
  // retry is enough.
  private async createWithUniqueSlug(
    memberId: string,
    dto: CreatePartnerApplicationInput,
  ): Promise<Partner> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle ?? dto.name, 'partner'),
        (s) => this.partners.exists({ where: { slug: s } }),
      );

      try {
        return await this.partners.save(
          this.partners.create({
            slug,
            name: dto.name,
            logo: dto.logo,
            region: dto.region,
            regionLabel: dto.regionLabel,
            city: dto.city,
            desc: dto.desc,
            tags: dto.tags ?? [],
            tier: dto.tier,
            since: dto.since,
            eyebrow: dto.eyebrow,
            tagline: dto.tagline,
            about: dto.about ?? [],
            stats: dto.stats ?? [],
            aboutMore: dto.aboutMore ?? [],
            jointWork: dto.jointWork ?? [],
            timeline: dto.timeline ?? [],
            how: dto.how ?? [],
            funding: dto.funding ?? '',
            atGlance: dto.atGlance ?? [],
            contact: normalizeContact(dto.contact),
            status: PartnerStatus.Pending,
            submittedById: memberId,
            reviewNote: null,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry.
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique partner slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved partner or throws above.
    throw new ConflictException('Could not allocate a unique partner slug');
  }

  private async buildApplication(
    partner: Partner,
  ): Promise<PartnerApplicationDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds([
      partner.submittedById,
    ]);
    return toPartnerApplication(
      partner,
      refs.get(partner.submittedById) ?? null,
    );
  }

  private async buildApplications(
    partners: Partner[],
  ): Promise<PartnerApplicationDTO[]> {
    const refs = await new MemberLookup(this.profiles).byUserIds(
      partners.map((p) => p.submittedById),
    );
    return partners.map((p) =>
      toPartnerApplication(p, refs.get(p.submittedById) ?? null),
    );
  }
}
