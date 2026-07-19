import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup, toMemberRef } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  Workshop,
  WorkshopHeroTint,
  WorkshopLocation,
  WorkshopMode,
  WorkshopNeed,
  WorkshopSession,
  WorkshopTier,
} from './entities/workshop.entity';
import { WorkshopRsvpsService } from './workshop-rsvps.service';
import { toWorkshopDTO, WorkshopDTO } from './workshop-response';

// Postgres unique-violation SQLSTATE. Mirrors `JobsService`'s identical
// file-local helper (not shared/exported, kept consistent with that
// precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

export interface CreateWorkshopInput {
  title: string;
  titleEm?: string;
  blurb: string;
  cat: string;
  mode: WorkshopMode;
  weeks: number;
  spotsTotal: number;
  price: number;
  currency?: string;
  priceSub?: string;
  startDate?: string;
  cancellation?: string;
  heroPlaceholder?: string;
  heroTint?: WorkshopHeroTint;
  hostRole?: string;
  about: string[];
  tiers?: Array<{ label: string; amount: number; sliding?: boolean }>;
  sessions?: Array<{
    n: string;
    title: string;
    desc: string;
    date: string;
    length: string;
    done?: boolean;
  }>;
  needs?: Array<{
    label: string;
    detail: string;
    included?: boolean;
    tag?: string;
  }>;
  pastWork?: string[];
  tags?: string[];
  location?: { name?: string; address?: string; access?: string };
}

// A workshop's host is fixed at creation, so — unlike `UpdateJobInput`, which
// has to omit `companySlug`/`company` — every creation field is patchable.
export type UpdateWorkshopInput = Partial<CreateWorkshopInput>;

export interface WorkshopListQuery {
  cat?: string;
  page?: number;
}

/** Fills every optional subfield so the `jsonb NOT NULL` `location` column is
 *  always fully populated (mirrors `JobsService.normalizeDetail`). */
function normalizeLocation(
  location?: CreateWorkshopInput['location'],
): WorkshopLocation {
  return {
    name: location?.name ?? '',
    address: location?.address ?? '',
    access: location?.access ?? '',
  };
}

// The three normalizers below exist for the same reason `normalizeDetail`
// does: the jsonb columns are NOT NULL and their element types have no
// optional members, so a partially-specified element from the DTO is filled
// in here rather than leaving `undefined` to round-trip through Postgres.
function normalizeTiers(tiers?: CreateWorkshopInput['tiers']): WorkshopTier[] {
  return (tiers ?? []).map((t) => ({
    label: t.label,
    amount: t.amount,
    sliding: t.sliding ?? false,
  }));
}

function normalizeSessions(
  sessions?: CreateWorkshopInput['sessions'],
): WorkshopSession[] {
  return (sessions ?? []).map((s) => ({
    n: s.n,
    title: s.title,
    desc: s.desc,
    date: s.date,
    length: s.length,
    done: s.done ?? false,
  }));
}

function normalizeNeeds(needs?: CreateWorkshopInput['needs']): WorkshopNeed[] {
  return (needs ?? []).map((n) => ({
    label: n.label,
    detail: n.detail,
    included: n.included ?? false,
    tag: n.tag ?? null,
  }));
}

@Injectable()
export class WorkshopsService {
  constructor(
    @InjectRepository(Workshop)
    private readonly workshops: Repository<Workshop>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
    private readonly rsvps: WorkshopRsvpsService,
  ) {}

  async create(hostId: string, dto: CreateWorkshopInput): Promise<WorkshopDTO> {
    const workshop = await this.createWithUniqueSlug(hostId, dto);
    return this.buildDTO(workshop, hostId);
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // create; the unique index on `slug` is the real backstop and turns that
  // race into a 23505, which forces a fresh slug + retry. Lifted verbatim in
  // shape from `JobsService.createWithUniqueSlug` — the closest precedent, a
  // member-posted listing slugged from its own title.
  private async createWithUniqueSlug(
    hostId: string,
    dto: CreateWorkshopInput,
  ): Promise<Workshop> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.title, 'workshop'),
        (s) => this.workshops.exists({ where: { slug: s } }),
      );

      try {
        return await this.workshops.save(
          this.workshops.create({
            slug,
            hostId,
            hostRole: dto.hostRole ?? null,
            cat: dto.cat,
            title: dto.title,
            titleEm: dto.titleEm ?? '',
            mode: dto.mode,
            weeks: dto.weeks,
            spotsTotal: dto.spotsTotal,
            blurb: dto.blurb,
            about: dto.about,
            heroPlaceholder: dto.heroPlaceholder ?? null,
            heroTint: dto.heroTint ?? WorkshopHeroTint.Default,
            price: dto.price,
            currency: dto.currency ?? 'EUR',
            priceSub: dto.priceSub ?? null,
            startDate: dto.startDate ?? null,
            cancellation: dto.cancellation ?? null,
            tiers: normalizeTiers(dto.tiers),
            sessions: normalizeSessions(dto.sessions),
            needs: normalizeNeeds(dto.needs),
            pastWork: dto.pastWork ?? [],
            tags: dto.tags ?? [],
            location: normalizeLocation(dto.location),
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique workshop slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved workshop or throws above.
    throw new ConflictException('Could not allocate a unique workshop slug');
  }

  async list(
    viewerId: string,
    query: WorkshopListQuery,
  ): Promise<Paginated<WorkshopDTO>> {
    const page = normalizePage(query.page);
    const qb = this.workshops
      .createQueryBuilder('w')
      .orderBy('w.created_at', 'DESC');

    if (query.cat) {
      qb.andWhere('w.cat = :cat', { cat: query.cat });
    }

    // Workshops hosted by a member the viewer blocked (either way) or muted
    // are dropped in-query, so a page fills to PAGE_SIZE with visible rows
    // instead of coming back short (see `BlockFilterService.excludeHidden`).
    // The column is spliced into raw SQL, hence the already-quoted
    // snake_case reference rather than a TypeORM property path.
    this.blockFilter.excludeHidden(qb, viewerId, '"w"."host_id"');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      // Two grouped queries for the page, never one per row.
      const [hosts, filled] = await Promise.all([
        new MemberLookup(this.profiles).byUserIds(rows.map((w) => w.hostId)),
        this.rsvps.spotsFilledForMany(rows.map((w) => w.id)),
      ]);
      return rows.map((w) =>
        toWorkshopDTO(
          w,
          hosts.get(w.hostId) ?? null,
          w.hostId === viewerId,
          filled.get(w.id) ?? 0,
          // `myRsvpStatus` stays null on cards. It would cost a third query for
          // a value the catalogue never renders — the reserve control lives on
          // the workshop's own page, which uses the detail route.
          null,
        ),
      );
    });
  }

  async getBySlug(slug: string, viewerId: string): Promise<WorkshopDTO> {
    const workshop = await this.loadOr404(slug);
    return this.buildDTO(workshop, viewerId);
  }

  async update(
    slug: string,
    hostId: string,
    dto: UpdateWorkshopInput,
  ): Promise<WorkshopDTO> {
    const workshop = await this.assertHost(slug, hostId, 'update');

    Object.assign(workshop, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.titleEm !== undefined ? { titleEm: dto.titleEm } : {}),
      ...(dto.blurb !== undefined ? { blurb: dto.blurb } : {}),
      ...(dto.cat !== undefined ? { cat: dto.cat } : {}),
      ...(dto.mode !== undefined ? { mode: dto.mode } : {}),
      ...(dto.weeks !== undefined ? { weeks: dto.weeks } : {}),
      ...(dto.spotsTotal !== undefined ? { spotsTotal: dto.spotsTotal } : {}),
      ...(dto.price !== undefined ? { price: dto.price } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.priceSub !== undefined ? { priceSub: dto.priceSub ?? null } : {}),
      ...(dto.startDate !== undefined
        ? { startDate: dto.startDate ?? null }
        : {}),
      ...(dto.cancellation !== undefined
        ? { cancellation: dto.cancellation ?? null }
        : {}),
      ...(dto.heroPlaceholder !== undefined
        ? { heroPlaceholder: dto.heroPlaceholder ?? null }
        : {}),
      ...(dto.heroTint !== undefined ? { heroTint: dto.heroTint } : {}),
      ...(dto.hostRole !== undefined ? { hostRole: dto.hostRole ?? null } : {}),
      ...(dto.about !== undefined ? { about: dto.about } : {}),
      ...(dto.tiers !== undefined ? { tiers: normalizeTiers(dto.tiers) } : {}),
      ...(dto.sessions !== undefined
        ? { sessions: normalizeSessions(dto.sessions) }
        : {}),
      ...(dto.needs !== undefined ? { needs: normalizeNeeds(dto.needs) } : {}),
      ...(dto.pastWork !== undefined ? { pastWork: dto.pastWork } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.location !== undefined
        ? { location: normalizeLocation(dto.location) }
        : {}),
    });

    const saved = await this.workshops.save(workshop);
    return this.buildDTO(saved, hostId);
  }

  // 204, no body (`WorkshopsController.remove`'s `@HttpCode`). Hard delete,
  // matching `ListingsService.remove` — a workshop is member-owned catalogue
  // copy, not moderation history, so there is nothing to retain.
  //
  // Since `AddWorkshopRsvps` this also destroys every booking on the workshop,
  // via `workshop_rsvps.workshop_id`'s ON DELETE CASCADE. The host is told how
  // many people that is *before* they confirm — the confirmation modal reads
  // `spotsFilled` off the detail DTO it already has, so no extra route is
  // needed here. Nobody is notified: there is no email service and no workshop
  // notification type, and the copy says so rather than implying otherwise.
  async remove(slug: string, hostId: string): Promise<void> {
    const workshop = await this.assertHost(slug, hostId, 'delete');
    await this.workshops.remove(workshop);
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Workshop> {
    const workshop = await this.workshops.findOne({ where: { slug } });
    if (!workshop) {
      throw new NotFoundException('Workshop not found');
    }
    return workshop;
  }

  // Loads + host-gates in one step: `update` and `remove` share the identical
  // 404-then-403 ordering (an unknown slug is a 404 for everyone, including
  // the would-be host).
  private async assertHost(
    slug: string,
    hostId: string,
    action: string,
  ): Promise<Workshop> {
    const workshop = await this.loadOr404(slug);
    if (workshop.hostId !== hostId) {
      throw new ForbiddenException(`Only the host can ${action} this workshop`);
    }
    return workshop;
  }

  private async buildDTO(
    workshop: Workshop,
    viewerId: string,
  ): Promise<WorkshopDTO> {
    const isHost = workshop.hostId === viewerId;
    const [hostProfile, spotsFilled, myRsvpStatus] = await Promise.all([
      this.profiles.findOne({ where: { userId: workshop.hostId } }),
      this.rsvps.spotsFilledFor(workshop.id),
      // The host cannot book their own workshop, so there is never a row to
      // look for — skip the query rather than ask a question with one answer.
      isHost
        ? Promise.resolve(null)
        : this.rsvps.myStatusFor(workshop.id, viewerId),
    ]);
    return toWorkshopDTO(
      workshop,
      toMemberRef(hostProfile),
      isHost,
      spotsFilled,
      myRsvpStatus,
    );
  }
}
