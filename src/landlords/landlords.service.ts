import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
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
    private readonly verification: VerificationService,
    private readonly affirmingPledge: AffirmingPledgeService,
  ) {}

  /** Batched recommendation-author verification levels (honest badge). Missing
   * ids resolve to the email floor. */
  private async recLevels(
    authorUserIds: string[],
  ): Promise<Map<string, VerificationLevel>> {
    return this.verification.levelsForUsers(authorUserIds);
  }

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
    // Identical to the private builder below, which is the one place the
    // recommendation cap and the rating aggregate are maintained.
    return this.detailFromEntity(landlord);
  }

  async suggest(
    userId: string,
    dto: CreateLandlordDto,
  ): Promise<LandlordDetailDTO> {
    // Baseline gate: suggesting a landlord requires the affirming pledge.
    await this.affirmingPledge.requireAccepted(userId);
    const saved = await this.createWithUniqueSlug(
      dto,
      LandlordStatus.Review,
      userId,
    );
    return this.detailFromEntity(saved);
  }

  /**
   * Create or update the caller's rating of a landlord.
   *
   * BE-HSG-18: a recommendation is a public, named rating of a real third party
   * who is not a member here and has no right of reply on this surface, and it
   * feeds `ratingFromRecommendations` on every landlord card. It carried none of
   * the gates `createIntroRequest` two methods below has always had, so an
   * account with only an email on file and no affirming pledge could rate a
   * named person. It now carries both: the mandatory pledge and the same
   * phone-verification step-up.
   *
   * Still open (a follow-up, not something to fake here): there is no proof the
   * recommender ever rented from this landlord. Tying a recommendation to an
   * accepted `landlord_intro_requests` row is the natural interaction gate, but
   * it needs a product decision about the members who found their home through
   * a landlord they met off-platform.
   */
  async recommend(
    slug: string,
    authorUserId: string,
    dto: CreateRecommendationDto,
  ): Promise<RecommendationDTO> {
    // Baseline gate: rating a landlord is a housing action like any other.
    await this.affirmingPledge.requireAccepted(authorUserId);
    // Step-up gate: a public rating of a named person needs a real phone behind
    // it, matching the intro-request path.
    await this.verification.requireLevel(authorUserId, VerificationLevel.Phone);
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
    const level = await this.verification.levelForUser(authorUserId);
    return toRecommendationDTO(saved, members.get(authorUserId) ?? null, level);
  }

  /**
   * The author withdraws their own recommendation (BE-HSG-18). Until this
   * existed, `removeRecommendation` lived only on the admin controller, so a
   * member who regretted what they wrote about a named real person could not
   * take it down without finding a moderator.
   *
   * Idempotent: no row means there is nothing to withdraw, which is the state
   * the caller asked for, so it succeeds rather than 404s.
   */
  async removeMyRecommendation(
    slug: string,
    authorUserId: string,
  ): Promise<void> {
    const landlord = await this.loadLiveOr404(slug);
    await this.recommendations.delete({
      landlordId: landlord.id,
      authorUserId,
    });
  }

  async createIntroRequest(
    slug: string,
    userId: string,
    dto: CreateIntroRequestDto,
  ): Promise<{ id: string; status: string }> {
    // Baseline gate: requesting an intro requires the affirming pledge.
    await this.affirmingPledge.requireAccepted(userId);
    // Step-up gate: asking for a landlord intro needs a phone-verified account.
    await this.verification.requireLevel(userId, VerificationLevel.Phone);
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
    const rows = await this.landlords.find({
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];
    const ratings = await this.ratingsFor(rows.map((r) => r.id));
    return rows.map((r) =>
      toLandlordCardDTO(r, ratings.get(r.id) ?? { score: '0', count: 0 }),
    );
  }

  async adminCreate(
    requesterUserId: string,
    dto: CreateLandlordDto,
  ): Promise<LandlordDetailDTO> {
    // No stored baseline on create, so any foreign photo key is refused (see
    // `assertNoForeignUploadIntroduced`). The admin create form presigns its
    // own upload in the acting admin's session, so `owner === requester` and a
    // legitimate create passes; only a copied foreign key is blocked.
    assertNoForeignUploadIntroduced(requesterUserId, dto.photo, []);
    const saved = await this.createWithUniqueSlug(
      dto,
      LandlordStatus.Live,
      null,
    );
    return this.detailFromEntity(saved);
  }

  async update(
    requesterUserId: string,
    id: string,
    dto: UpdateLandlordDto,
  ): Promise<LandlordDetailDTO> {
    const landlord = await this.loadByIdOr404(id);
    // Runs BEFORE mutating: a moderator/admin may re-save the photo whichever
    // staffer sourced it uploaded, but may not point it at a NEW foreign key.
    assertNoForeignUploadIntroduced(requesterUserId, dto.photo, [
      landlord.photo,
    ]);
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
      take: DEFAULT_LIST_LIMIT,
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
    // Newest `DEFAULT_LIST_LIMIT` recommendations, not every one ever written:
    // this was an unbounded read whose cost grew with the landlord's history,
    // and it also drove a member lookup and a verification-level lookup per row.
    const recs = await this.recommendations.find({
      where: { landlordId: landlord.id },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const members = await new MemberLookup(this.profiles).byUserIds(
      recs.map((rec) => rec.authorUserId),
    );
    const levels = await this.recLevels(recs.map((rec) => rec.authorUserId));
    const recDTOs: RecommendationDTO[] = recs.map((rec) =>
      toRecommendationDTO(
        rec,
        members.get(rec.authorUserId) ?? null,
        levels.get(rec.authorUserId) ?? VerificationLevel.Email,
      ),
    );
    // The headline rating has to be computed over EVERY recommendation, so it
    // is aggregated in Postgres rather than derived from the capped page above
    // — capping the list must not quietly change the score.
    return toLandlordDetailDTO(
      landlord,
      recDTOs,
      await this.rating(landlord.id),
    );
  }

  /** Average stars + count for one landlord, aggregated in SQL. */
  private async rating(
    landlordId: string,
  ): Promise<{ score: string; count: number }> {
    const row = await this.recommendations
      .createQueryBuilder('r')
      .select('AVG(r.stars)', 'average')
      .addSelect('COUNT(*)', 'count')
      .where('r.landlord_id = :landlordId', { landlordId })
      .getRawOne<{ average: string | null; count: string }>();
    const count = Number(row?.count ?? 0);
    if (!count || row?.average == null) return { score: '0', count: 0 };
    return { score: Number(row.average).toFixed(1), count };
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
