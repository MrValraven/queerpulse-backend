import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { normalizePage } from '../common/pagination';
import { Repository } from 'typeorm';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from './entities/coop-join-request.entity';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { HousingCoop } from './entities/housing-coop.entity';
import { CreateCoopDto } from './dto/create-coop.dto';
import { UpdateCoopDto } from './dto/update-coop.dto';
import { CreateHousingJoinRequestDto } from './dto/create-join-request.dto';
import {
  AdminJoinRequestDTO,
  AdminJoinRequestsPageDTO,
  HousingCoopDTO,
  toAdminJoinRequestDTO,
  toHousingCoopDTO,
} from './housing-coop-response';
import { ListCoopJoinRequestsQuery } from './dto/list-coop-join-requests.query';

// Postgres unique-violation SQLSTATE. Mirrors `ListingsService`'s/
// `CompaniesService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
/**
 * Page size for the admin co-op join-request triage queue (ENG-41). 20 matches
 * the platform-wide `PAGE_SIZE` and the sibling
 * `GROUP_JOIN_REQUEST_QUEUE_PAGE_SIZE`, so both housing queues page identically.
 */
export const COOP_JOIN_REQUEST_QUEUE_PAGE_SIZE = 20;

@Injectable()
export class HousingService {
  constructor(
    @InjectRepository(HousingCoop)
    private readonly coops: Repository<HousingCoop>,
    @InjectRepository(CoopJoinRequest)
    private readonly joinRequests: Repository<CoopJoinRequest>,
    private readonly affirmingPledge: AffirmingPledgeService,
  ) {}

  async listPublished(): Promise<HousingCoopDTO[]> {
    const coops = await this.coops.find({
      where: { published: true },
      order: { createdAt: 'ASC' },
    });
    return coops.map(toHousingCoopDTO);
  }

  async listAllForAdmin(): Promise<HousingCoopDTO[]> {
    const coops = await this.coops.find({ order: { createdAt: 'ASC' } });
    return coops.map(toHousingCoopDTO);
  }

  async createJoinRequest(
    slug: string,
    dto: CreateHousingJoinRequestDto,
    userId: string | null,
  ): Promise<{ id: string }> {
    const coop = await this.coops.findOne({ where: { slug, published: true } });
    if (!coop) throw new NotFoundException('Co-op not found');
    // Baseline gate: a signed-in member asking to join commits to the affirming
    // pledge. Anonymous applicants (userId null — the public co-op page
    // deliberately collects a `name` so a non-member can ask to be let in) are
    // NOT gated: the pledge is a member commitment, captured when they join.
    if (userId) await this.affirmingPledge.requireAccepted(userId);
    const saved = await this.joinRequests.save(
      this.joinRequests.create({
        coopId: coop.id,
        name: dto.name,
        householdSize: dto.householdSize,
        note: dto.note ?? null,
        userId,
        status: JoinRequestStatus.Pending,
      }),
    );
    return { id: saved.id };
  }

  async createCoop(dto: CreateCoopDto): Promise<HousingCoopDTO> {
    const existing = await this.coops.findOne({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException('Slug already in use');
    try {
      const saved = await this.coops.save(
        this.coops.create({
          ...dto,
          nameEm: dto.nameEm ?? null,
          operationalSince: dto.operationalSince ?? null,
          formingSince: dto.formingSince ?? null,
          shareAmountEuros: dto.shareAmountEuros ?? null,
          monthlyEuros: dto.monthlyEuros ?? null,
          faces: dto.faces ?? [],
        }),
      );
      return toHousingCoopDTO(saved);
    } catch (err) {
      // The pre-check above can race with a concurrent create of the same
      // slug; the unique index is the real backstop. Map 23505 to a clean
      // 409 instead of letting it surface as a raw 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException('Slug already in use');
      }
      throw err;
    }
  }

  async updateCoop(id: string, dto: UpdateCoopDto): Promise<HousingCoopDTO> {
    const coop = await this.coops.findOne({ where: { id } });
    if (!coop) throw new NotFoundException('Co-op not found');
    Object.assign(coop, dto);
    try {
      return toHousingCoopDTO(await this.coops.save(coop));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Slug already in use');
      }
      throw err;
    }
  }

  async deleteCoop(id: string): Promise<void> {
    const result = await this.coops.delete({ id });
    if (!result.affected) throw new NotFoundException('Co-op not found');
  }

  /**
   * Admin-only: the co-op join-request triage queue, newest first, paginated
   * (ENG-41).
   *
   * Supersedes the note that stood here, which recorded the response as "a flat
   * `AdminJoinRequestDTO[]` (no pagination envelope callers read)". Bounding the
   * query at `DEFAULT_LIST_LIMIT` (AUDIT item #19) was right, because before
   * that it returned every join request on the platform with no cap at all.
   * Returning nothing BUT the bounded slab was not: a platform with 201 requests
   * dropped one of them with nothing in the response saying so, and once the
   * queue passes 200 the drop grows silently with it. The envelope now carries
   * `total`, the size of the whole filtered queue, and `page`, which is how an
   * admin reaches the rest of it.
   *
   * ORDERING STAYS NEWEST-FIRST, deliberately. That is this queue's existing
   * behaviour and the sibling `HousingGroupsService.listJoinRequests`'s too. The
   * truncation was the defect here, never the sort, so please do not "fix" the
   * direction: with `total` and `page` in the envelope nothing is hidden at
   * either end of the order.
   *
   * `status` is what makes this more than a truncation fix. The console rendered
   * pending requests only, and it got there by filtering `status === 'pending'`
   * in the browser over whatever the newest 200 rows happened to be. So 200
   * decided requests newer than one pending request showed every admin an empty
   * queue while somebody waited. Filtering in the query is also what lets
   * `total` count the pending set rather than the whole table.
   *
   * `total` is honest without any `EXISTS` guard, and that is worth stating
   * because the sibling `ListingClaimsService.listPending` needed one. Nothing
   * is dropped after the fetch here: `coop_id` carries a real FK to
   * `housing_coops` `ON DELETE CASCADE` (`1785000010000-AddHousing`), so a
   * deleted co-op takes its requests with it and cannot leave an orphan behind,
   * and even if one somehow existed `toAdminJoinRequestDTO` maps a missing
   * relation to `coop: null` and still returns the row rather than discarding
   * it. Every row these pages fetch reaches the caller, so `total` is exactly
   * the number of requests reachable through them.
   *
   * `.offset()`/`.limit()` rather than `.skip()`/`.take()`: those two go through
   * TypeORM's distinct-primary-id subquery pass, which exists to stop a joined
   * collection from multiplying rows and eating into the page, and it misreads
   * an ORDER BY that names a joined alias. `request.coop` is a ManyToOne, so the
   * join can only ever produce one row per request and there is nothing to
   * de-duplicate; the raw offset/limit keeps the joined-alias `coop.slug` filter
   * and the ordered limit in one plain query. Mirrors the sibling housing-groups
   * queue, which has the identical join shape.
   *
   * Indexes: the co-op-scoped path stays on
   * `IDX_coop_join_requests_coop_id_created_at`
   * (`1785903100000-AddCoopJoinRequestsCoopCreatedAtIndex`). The unscoped path,
   * which is the console's default, and the new `COUNT(*)` are served by
   * `IDX_coop_join_requests_status_created_at`
   * (`1796100100000-AddCoopJoinRequestQueueIndex`).
   */
  async listJoinRequests(
    query: ListCoopJoinRequestsQuery = {},
  ): Promise<AdminJoinRequestsPageDTO> {
    const page = normalizePage(query.page);
    const pageSize = COOP_JOIN_REQUEST_QUEUE_PAGE_SIZE;

    const joinRequestsQuery = this.joinRequests
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.coop', 'coop')
      // `created_at` alone is not a total order, so it is not a safe sort key for
      // offset pagination: two rows written in the same transaction share a
      // statement timestamp, and Postgres is then free to return that tie in
      // either order per query, which is how a row appears on two pages and
      // another appears on none. `id` breaks the tie deterministically. Same
      // reasoning as `PlatformSettingsService.listChanges`.
      .orderBy('request.createdAt', 'DESC')
      .addOrderBy('request.id', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    if (query.status) {
      joinRequestsQuery.andWhere('request.status = :status', {
        status: query.status,
      });
    }
    if (query.coop) {
      joinRequestsQuery.andWhere('coop.slug = :coopSlug', {
        coopSlug: query.coop,
      });
    }

    const [requests, total] = await joinRequestsQuery.getManyAndCount();
    const items: AdminJoinRequestDTO[] = requests.map(toAdminJoinRequestDTO);
    return { items, total, page, pageSize };
  }

  async triageJoinRequest(
    id: string,
    action: 'accepted' | 'declined',
  ): Promise<AdminJoinRequestDTO> {
    const request = await this.joinRequests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Join request not found');
    request.status =
      action === 'accepted'
        ? JoinRequestStatus.Accepted
        : JoinRequestStatus.Declined;
    await this.joinRequests.save(request);
    const updated = await this.joinRequests.findOne({
      where: { id },
      relations: { coop: true },
    });
    return toAdminJoinRequestDTO(updated!);
  }
}
