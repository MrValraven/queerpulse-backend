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
import { CreateIntroRequestDto } from './dto/create-intro-request.dto';
import { CreateLandlordDto } from './dto/create-landlord.dto';
import { CreateRecommendationDto } from './dto/create-recommendation.dto';
import { UpdateLandlordDto } from './dto/update-landlord.dto';
import {
  LandlordIntroRequest,
  LandlordIntroRequestStatus,
} from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord, LandlordStatus } from './entities/landlord.entity';
import { BrowseLandlordsQuery } from './dto/browse-landlords.query';
import {
  IntroRequestDTO,
  LandlordCardDTO,
  LandlordDetailDTO,
  ratingFromRecommendations,
  RecommendationDTO,
  toIntroRequestDTO,
  toLandlordCardDTO,
  toLandlordDetailDTO,
  toRecommendationDTO,
} from './landlord-response';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

/** Applies only present fields onto a landlord (create defaulting + PATCH). */
function applyLandlord(
  landlord: Landlord,
  dto: CreateLandlordDto | UpdateLandlordDto,
): void {
  if (dto.name !== undefined) landlord.name = dto.name;
  if (dto.hood !== undefined) landlord.hood = dto.hood;
  if (dto.photo !== undefined) landlord.photo = dto.photo;
  if (dto.tagline !== undefined) landlord.tagline = dto.tagline;
  if (dto.note !== undefined) landlord.note = dto.note;
  if (dto.about !== undefined) landlord.about = dto.about;
  if (dto.areas !== undefined) landlord.areas = dto.areas;
  if (dto.rentingNote !== undefined) landlord.rentingNote = dto.rentingNote;
  if (dto.stats !== undefined) landlord.stats = dto.stats;
}

/**
 * Community landlord directory. Member ops (browse/detail/suggest/recommend/
 * intro) + admin ops (moderation/triage). Entities are relation-free — children
 * are queried by `landlordId`.
 */
@Injectable()
export class LandlordsService {
  constructor(
    @InjectRepository(Landlord)
    private readonly landlords: Repository<Landlord>,
    @InjectRepository(LandlordRecommendation)
    private readonly recommendations: Repository<LandlordRecommendation>,
    @InjectRepository(LandlordIntroRequest)
    private readonly introRequests: Repository<LandlordIntroRequest>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  // --- member ops ---

  async browse(
    query: BrowseLandlordsQuery,
  ): Promise<Paginated<LandlordCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.landlords
      .createQueryBuilder('l')
      .where('l.status = :live', { live: LandlordStatus.Live });
    if (query.hood) {
      qb.andWhere('LOWER(l.hood) = LOWER(:hood)', { hood: query.hood });
    }
    qb.orderBy('l.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const ratings = await this.ratingsFor(rows.map((r) => r.id));
      return rows.map((r) =>
        toLandlordCardDTO(r, ratings.get(r.id) ?? { score: '0', count: 0 }),
      );
    });
  }

  async detail(slug: string): Promise<LandlordDetailDTO> {
    const landlord = await this.landlords.findOne({
      where: { slug, status: LandlordStatus.Live },
    });
    if (!landlord) {
      throw new NotFoundException('Landlord not found');
    }
    const recs = await this.recommendations.find({
      where: { landlordId: landlord.id },
      order: { createdAt: 'DESC' },
    });
    const members = await new MemberLookup(this.profiles).byUserIds(
      recs.map((rec) => rec.authorUserId),
    );
    const recDTOs: RecommendationDTO[] = recs.map((rec) =>
      toRecommendationDTO(rec, members.get(rec.authorUserId) ?? null),
    );
    return toLandlordDetailDTO(
      landlord,
      recDTOs,
      ratingFromRecommendations(recs),
    );
  }

  async suggest(
    userId: string,
    dto: CreateLandlordDto,
  ): Promise<LandlordDetailDTO> {
    const saved = await this.createWithUniqueSlug(
      dto,
      LandlordStatus.Review,
      userId,
    );
    return this.detailFromEntity(saved);
  }

  async recommend(
    slug: string,
    authorUserId: string,
    dto: CreateRecommendationDto,
  ): Promise<RecommendationDTO> {
    const landlord = await this.loadLiveOr404(slug);
    const rec = await this.recommendations.findOne({
      where: { landlordId: landlord.id, authorUserId },
    });
    let saved: LandlordRecommendation;
    if (rec) {
      rec.stars = dto.stars;
      rec.text = dto.text;
      saved = await this.recommendations.save(rec);
    } else {
      const created = this.recommendations.create({
        landlordId: landlord.id,
        authorUserId,
        stars: dto.stars,
        text: dto.text,
      });
      try {
        saved = await this.recommendations.save(created);
      } catch (err) {
        // Two concurrent first-recommends by the same author can both miss
        // the find above and both attempt an insert; the loser trips
        // UQ_landlord_recommendations_author. Re-find and update instead of
        // letting it surface as a 500.
        if (!isUniqueViolation(err)) throw err;
        const raced = await this.recommendations.findOne({
          where: { landlordId: landlord.id, authorUserId },
        });
        if (!raced) throw err;
        raced.stars = dto.stars;
        raced.text = dto.text;
        saved = await this.recommendations.save(raced);
      }
    }
    const members = await new MemberLookup(this.profiles).byUserIds([
      authorUserId,
    ]);
    return toRecommendationDTO(saved, members.get(authorUserId) ?? null);
  }

  async createIntroRequest(
    slug: string,
    userId: string,
    dto: CreateIntroRequestDto,
  ): Promise<{ id: string; status: string }> {
    const landlord = await this.loadLiveOr404(slug);
    const saved = await this.introRequests.save(
      this.introRequests.create({
        landlordId: landlord.id,
        userId,
        name: dto.name,
        note: dto.note ?? null,
        contactEmail: dto.contactEmail ?? null,
      }),
    );
    return { id: saved.id, status: saved.status };
  }

  // --- admin ops ---

  async listAllForAdmin(): Promise<LandlordCardDTO[]> {
    const rows = await this.landlords.find({ order: { createdAt: 'DESC' } });
    if (!rows.length) return [];
    const ratings = await this.ratingsFor(rows.map((r) => r.id));
    return rows.map((r) =>
      toLandlordCardDTO(r, ratings.get(r.id) ?? { score: '0', count: 0 }),
    );
  }

  async adminCreate(dto: CreateLandlordDto): Promise<LandlordDetailDTO> {
    const saved = await this.createWithUniqueSlug(
      dto,
      LandlordStatus.Live,
      null,
    );
    return this.detailFromEntity(saved);
  }

  async update(id: string, dto: UpdateLandlordDto): Promise<LandlordDetailDTO> {
    const landlord = await this.loadByIdOr404(id);
    applyLandlord(landlord, dto);
    const saved = await this.landlords.save(landlord);
    return this.detailFromEntity(saved);
  }

  async setStatus(
    id: string,
    status: LandlordStatus,
  ): Promise<LandlordDetailDTO> {
    const landlord = await this.loadByIdOr404(id);
    landlord.status = status;
    const saved = await this.landlords.save(landlord);
    return this.detailFromEntity(saved);
  }

  async remove(id: string): Promise<void> {
    const landlord = await this.loadByIdOr404(id);
    await this.landlords.remove(landlord);
  }

  async removeRecommendation(id: string): Promise<void> {
    const rec = await this.recommendations.findOne({ where: { id } });
    if (!rec) {
      throw new NotFoundException('Recommendation not found');
    }
    await this.recommendations.remove(rec);
  }

  async listIntroRequests(landlordSlug?: string): Promise<IntroRequestDTO[]> {
    let landlordId: string | undefined;
    if (landlordSlug) {
      const landlord = await this.landlords.findOne({
        where: { slug: landlordSlug },
      });
      if (!landlord) return [];
      landlordId = landlord.id;
    }
    const requests = await this.introRequests.find({
      where: landlordId ? { landlordId } : {},
      order: { createdAt: 'DESC' },
    });
    if (!requests.length) return [];
    const landlordById = await this.landlordsByIds(
      requests.map((r) => r.landlordId),
    );
    return requests.map((request) =>
      toIntroRequestDTO(request, landlordById.get(request.landlordId) ?? null),
    );
  }

  async triageIntroRequest(
    id: string,
    action: 'accepted' | 'declined',
  ): Promise<IntroRequestDTO> {
    const request = await this.introRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Intro request not found');
    }
    request.status =
      action === 'accepted'
        ? LandlordIntroRequestStatus.Accepted
        : LandlordIntroRequestStatus.Declined;
    const saved = await this.introRequests.save(request);
    const landlordById = await this.landlordsByIds([saved.landlordId]);
    return toIntroRequestDTO(saved, landlordById.get(saved.landlordId) ?? null);
  }

  // --- internals ---

  private async loadLiveOr404(slug: string): Promise<Landlord> {
    const landlord = await this.landlords.findOne({
      where: { slug, status: LandlordStatus.Live },
    });
    if (!landlord) {
      throw new NotFoundException('Landlord not found');
    }
    return landlord;
  }

  private async loadByIdOr404(id: string): Promise<Landlord> {
    const landlord = await this.landlords.findOne({ where: { id } });
    if (!landlord) {
      throw new NotFoundException('Landlord not found');
    }
    return landlord;
  }

  private async detailFromEntity(
    landlord: Landlord,
  ): Promise<LandlordDetailDTO> {
    const recs = await this.recommendations.find({
      where: { landlordId: landlord.id },
      order: { createdAt: 'DESC' },
    });
    const members = await new MemberLookup(this.profiles).byUserIds(
      recs.map((rec) => rec.authorUserId),
    );
    const recDTOs = recs.map((rec) =>
      toRecommendationDTO(rec, members.get(rec.authorUserId) ?? null),
    );
    return toLandlordDetailDTO(
      landlord,
      recDTOs,
      ratingFromRecommendations(recs),
    );
  }

  private async ratingsFor(
    landlordIds: string[],
  ): Promise<Map<string, { score: string; count: number }>> {
    const map = new Map<string, { score: string; count: number }>();
    if (!landlordIds.length) return map;
    const recs = await this.recommendations.find({
      where: { landlordId: In(landlordIds) },
    });
    const byLandlord = new Map<string, LandlordRecommendation[]>();
    for (const rec of recs) {
      const list = byLandlord.get(rec.landlordId);
      if (list) list.push(rec);
      else byLandlord.set(rec.landlordId, [rec]);
    }
    for (const id of landlordIds) {
      map.set(id, ratingFromRecommendations(byLandlord.get(id) ?? []));
    }
    return map;
  }

  private async landlordsByIds(ids: string[]): Promise<Map<string, Landlord>> {
    const map = new Map<string, Landlord>();
    if (!ids.length) return map;
    const rows = await this.landlords.find({ where: { id: In(ids) } });
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  private async createWithUniqueSlug(
    dto: CreateLandlordDto,
    status: LandlordStatus,
    submittedByUserId: string | null,
  ): Promise<Landlord> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.name, 'landlord'),
        (s) => this.landlords.exists({ where: { slug: s } }),
      );
      try {
        const landlord = this.landlords.create({
          slug,
          status,
          submittedByUserId,
        });
        applyLandlord(landlord, dto);
        return await this.landlords.save(landlord);
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) continue;
          throw new ConflictException(
            'Could not allocate a unique landlord slug',
          );
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique landlord slug');
  }
}
