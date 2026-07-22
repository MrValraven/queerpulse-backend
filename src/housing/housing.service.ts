import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from './entities/coop-join-request.entity';
import { HousingCoop } from './entities/housing-coop.entity';
import { CreateCoopDto } from './dto/create-coop.dto';
import { UpdateCoopDto } from './dto/update-coop.dto';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';

// Postgres unique-violation SQLSTATE. Mirrors `ListingsService`'s/
// `CompaniesService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

@Injectable()
export class HousingService {
  constructor(
    @InjectRepository(HousingCoop)
    private readonly coops: Repository<HousingCoop>,
    @InjectRepository(CoopJoinRequest)
    private readonly joinRequests: Repository<CoopJoinRequest>,
  ) {}

  listPublished(): Promise<HousingCoop[]> {
    return this.coops.find({
      where: { published: true },
      order: { createdAt: 'ASC' },
    });
  }

  listAllForAdmin(): Promise<HousingCoop[]> {
    return this.coops.find({ order: { createdAt: 'ASC' } });
  }

  async createJoinRequest(
    slug: string,
    dto: CreateJoinRequestDto,
    userId: string | null,
  ): Promise<{ id: string }> {
    const coop = await this.coops.findOne({ where: { slug, published: true } });
    if (!coop) throw new NotFoundException('Co-op not found');
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

  async createCoop(dto: CreateCoopDto): Promise<HousingCoop> {
    const existing = await this.coops.findOne({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException('Slug already in use');
    try {
      return await this.coops.save(
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

  async updateCoop(id: string, dto: UpdateCoopDto): Promise<HousingCoop> {
    const coop = await this.coops.findOne({ where: { id } });
    if (!coop) throw new NotFoundException('Co-op not found');
    Object.assign(coop, dto);
    try {
      return await this.coops.save(coop);
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

  listJoinRequests(coopSlug?: string): Promise<CoopJoinRequest[]> {
    const query = this.joinRequests
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.coop', 'coop')
      .orderBy('request.createdAt', 'DESC');
    if (coopSlug) query.where('coop.slug = :coopSlug', { coopSlug });
    return query.getMany();
  }

  async triageJoinRequest(
    id: string,
    action: 'accepted' | 'declined',
  ): Promise<CoopJoinRequest> {
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
    return updated!;
  }
}
