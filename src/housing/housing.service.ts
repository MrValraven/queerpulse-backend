import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Repository } from 'typeorm';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from './entities/coop-join-request.entity';
import {
  CoopRelocationRequest,
  RelocationRequestStatus,
} from './entities/coop-relocation-request.entity';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { HousingCoop } from './entities/housing-coop.entity';
import { CreateCoopDto } from './dto/create-coop.dto';
import { UpdateCoopDto } from './dto/update-coop.dto';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { CreateRelocationRequestDto } from './dto/create-relocation-request.dto';
import { ResolveRelocationRequestDto } from './dto/resolve-relocation-request.dto';
import {
  AdminJoinRequestDTO,
  AdminRelocationRequestDTO,
  HousingCoopDTO,
  toAdminJoinRequestDTO,
  toAdminRelocationRequestDTO,
  toHousingCoopDTO,
} from './housing-coop-response';

// Postgres unique-violation SQLSTATE. Mirrors `ListingsService`'s/
// `CompaniesService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
@Injectable()
export class HousingService {
  constructor(
    @InjectRepository(HousingCoop)
    private readonly coops: Repository<HousingCoop>,
    @InjectRepository(CoopJoinRequest)
    private readonly joinRequests: Repository<CoopJoinRequest>,
    @InjectRepository(CoopRelocationRequest)
    private readonly relocationRequests: Repository<CoopRelocationRequest>,
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
    dto: CreateJoinRequestDto,
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

  async listJoinRequests(coopSlug?: string): Promise<AdminJoinRequestDTO[]> {
    // `take` bounds this admin list to `DEFAULT_LIST_LIMIT` (AUDIT item #19) —
    // it previously returned every join request on the platform, newest first,
    // with no cap. The response stays a flat `AdminJoinRequestDTO[]` (no
    // pagination envelope callers read), matching every other bounded-but-
    // unpaginated list in the repo. The coop-scoped path is served by
    // `IDX_coop_join_requests_coop_id_created_at`
    // (`1785903100000-AddCoopJoinRequestsCoopCreatedAtIndex`).
    const query = this.joinRequests
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.coop', 'coop')
      .orderBy('request.createdAt', 'DESC')
      .take(DEFAULT_LIST_LIMIT);
    if (coopSlug) query.where('coop.slug = :coopSlug', { coopSlug });
    const requests = await query.getMany();
    return requests.map(toAdminJoinRequestDTO);
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

  // --- Co-living conflict-resolution / relocation flow (P3.2) ---

  async createRelocationRequest(
    slug: string,
    dto: CreateRelocationRequestDto,
    userId: string | null,
  ): Promise<{ id: string }> {
    const coop = await this.coops.findOne({ where: { slug, published: true } });
    if (!coop) throw new NotFoundException('Co-op not found');
    const saved = await this.relocationRequests.save(
      this.relocationRequests.create({
        coopId: coop.id,
        name: dto.name,
        situation: dto.situation,
        userId,
        status: RelocationRequestStatus.Open,
      }),
    );
    return { id: saved.id };
  }

  async listRelocationRequests(
    coopSlug?: string,
  ): Promise<AdminRelocationRequestDTO[]> {
    const query = this.relocationRequests
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.coop', 'coop')
      .orderBy('request.createdAt', 'DESC')
      .take(DEFAULT_LIST_LIMIT);
    if (coopSlug) query.where('coop.slug = :coopSlug', { coopSlug });
    const requests = await query.getMany();
    return requests.map(toAdminRelocationRequestDTO);
  }

  async resolveRelocationRequest(
    id: string,
    dto: ResolveRelocationRequestDto,
    resolvedByUserId: string,
  ): Promise<AdminRelocationRequestDTO> {
    const request = await this.relocationRequests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Relocation request not found');
    request.status =
      dto.action === 'resolved'
        ? RelocationRequestStatus.Resolved
        : RelocationRequestStatus.Dismissed;
    request.outcome = dto.action === 'resolved' ? (dto.outcome ?? null) : null;
    request.resolvedByUserId = resolvedByUserId;
    request.resolvedAt = new Date();
    await this.relocationRequests.save(request);
    const updated = await this.relocationRequests.findOne({
      where: { id },
      relations: { coop: true },
    });
    return toAdminRelocationRequestDTO(updated!);
  }
}
