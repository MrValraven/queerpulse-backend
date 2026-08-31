import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  PAGE_SIZE,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { CreateIntroRequestDto } from './dto/create-intro-request.dto';
import { CreateLandlordDto } from './dto/create-landlord.dto';
import { CreateRecommendationDto } from './dto/create-recommendation.dto';
import { ListAdminLandlordsQuery } from './dto/list-admin-landlords.query';
import { ListIntroRequestsQuery } from './dto/list-intro-requests.query';
import { TriageIntroRequestDto } from './dto/triage-intro-request.dto';
import { UpdateLandlordDto } from './dto/update-landlord.dto';
import { UpdateLandlordStatusDto } from './dto/update-landlord-status.dto';
import {
  LandlordIntroRequest,
  LandlordIntroRequestStatus,
} from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord, LandlordStatus } from './entities/landlord.entity';
import { BrowseLandlordsQuery } from './dto/browse-landlords.query';
import {
  AdminLandlordDTO,
  AdminRecommendationDTO,
  IntroRequestDTO,
  LandlordCardDTO,
  LandlordDetailDTO,
  ratingFromRecommendations,
  RecommendationDTO,
  toAdminLandlordDTO,
  toAdminRecommendationDTO,
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
  private readonly logger = new Logger(LandlordsService.name);

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
    // LOC-19: the member who suggested an entry, or asked for an
    // introduction, is told what was decided. In-app plus push, never email.
    private readonly notifications: NotificationsService,
    // Read-only: a `hide_content`/`remove_content` takedown on a `landlord`
    // subject (keyed by the entry slug, which is what the report modal on
    // `LandlordPage` sends) withholds the entry from every member read below.
    private readonly contentModeration: ContentModerationService,
  ) {}

  // A landlord entry is reported (and taken down) under the `landlord` subject
  // code, keyed by the entry slug. A hidden OR removed entry vanishes from the
  // member browse and detail, and from every member route that loads a live
  // landlord by slug: this is a member surface with no per-viewer staff role,
  // so a takedown withholds it entirely, exactly as `HousingDirectoryService`
  // treats a `housing` takedown. The admin routes below deliberately do NOT
  // filter on it, so staff can still see and triage what they took down.
  private static readonly SUBJECT_TYPE = 'landlord';

  /**
   * NOT EXISTS predicate dropping any landlord under a `landlord` takedown
   * (hidden OR removed) from a landlord query builder (alias `l`). Applied
   * in-query so the page and its `getManyAndCount` total agree, and written as
   * a subquery rather than a join so the `.skip()`/`.take()` pagination
   * `paginate` uses stays correct. Mirrors
   * `HousingDirectoryService.excludeModeratedListings`.
   */
  private excludeModeratedLandlords(qb: SelectQueryBuilder<Landlord>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :landlordSubjectType
          AND "cm"."subject_id" = l.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { landlordSubjectType: LandlordsService.SUBJECT_TYPE },
    );
  }

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
    // Moderator takedowns, dropped in-query so the page and the total agree.
    this.excludeModeratedLandlords(qb);
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
    // Goes through the same loader every other member route uses, so the
    // moderation takedown check lives in exactly one place.
    const landlord = await this.loadLiveOr404(slug);
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

  /**
   * The landlord directory console's list (LOC-19).
   *
   * Replaces an uncapped slab of public cards with the page a moderator can
   * actually work: filtered by review state, neighbourhood and name, paginated,
   * and carrying the four things the slab omitted — the row `id` every admin
   * mutation is keyed by, the `status`, the member who suggested the entry, and
   * the decision already recorded on it.
   *
   * Newest first: unlike the housing queue there is no risk score to sort on
   * here, and a suggestion that has been waiting longest is the one most owed
   * an answer. The submitter refs are ONE batched profile lookup for the whole
   * page, never one query per row.
   */
  async listForAdmin(
    query: ListAdminLandlordsQuery,
  ): Promise<Paginated<AdminLandlordDTO>> {
    const page = normalizePage(query.page);
    const qb = this.landlords.createQueryBuilder('l');
    if (query.status) {
      qb.andWhere('l.status = :status', { status: query.status });
    }
    if (query.hood) {
      qb.andWhere('LOWER(l.hood) = LOWER(:hood)', { hood: query.hood });
    }
    if (query.q) {
      qb.andWhere('l.name ILIKE :q', { q: `%${query.q}%` });
    }
    qb.orderBy('l.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const ratings = await this.ratingsFor(rows.map((row) => row.id));
      const submitters = await this.submittersFor(rows);
      return rows.map((row) =>
        toAdminLandlordDTO(
          row,
          ratings.get(row.id) ?? { score: '0', count: 0 },
          row.submittedByUserId
            ? (submitters.get(row.submittedByUserId) ?? null)
            : null,
        ),
      );
    });
  }

  /** userId -> MemberRef for every row that carries a submitter. One query. */
  private async submittersFor(
    rows: Landlord[],
  ): Promise<Map<string, MemberRef>> {
    const submitterIds = [
      ...new Set(
        rows
          .map((row) => row.submittedByUserId)
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];
    if (!submitterIds.length) return new Map();
    return new MemberLookup(this.profiles).byUserIds(submitterIds);
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

  /**
   * Publish a suggested entry, or hold it back for review (LOC-19).
   *
   * IDEMPOTENT: an entry already in the requested state is returned unchanged,
   * with no second decision stamped and no second notification, so a
   * double-clicked approve or two moderators working the same queue cannot
   * tell the same member the same thing twice.
   *
   * A move back to `review` REQUIRES a reason whenever a member suggested the
   * entry, because that is the decision they need to be able to act on. Going
   * `live` does not: the notification is good news and the entry speaks for
   * itself.
   */
  async setStatus(
    id: string,
    dto: UpdateLandlordStatusDto,
    adminUserId: string,
  ): Promise<LandlordDetailDTO> {
    const landlord = await this.loadByIdOr404(id);
    if (landlord.status === dto.status) {
      return this.detailFromEntity(landlord);
    }

    const reason = LandlordsService.trimToNull(dto.reason);
    if (
      dto.status === LandlordStatus.Review &&
      landlord.submittedByUserId &&
      !reason
    ) {
      throw new BadRequestException(
        'Say why the entry is being held back. The member who suggested it reads this.',
      );
    }

    landlord.status = dto.status;
    landlord.decidedAt = new Date();
    landlord.decidedBy = adminUserId;
    landlord.decisionReason = reason;
    const saved = await this.landlords.save(landlord);

    await this.notifySuggester(saved, dto.status, reason);

    return this.detailFromEntity(saved);
  }

  /**
   * Remove a directory entry (LOC-19).
   *
   * A member-suggested entry cannot be removed silently: the reason is
   * REQUIRED and is sent to the member who suggested it. A staff-created entry
   * has nobody to tell, so no reason is demanded of the moderator deleting it.
   *
   * The notification is built from values captured BEFORE the delete and sent
   * after it, so the member is only ever told about a removal that actually
   * happened, and the row is gone by the time they tap through.
   */
  async remove(id: string, reason?: string): Promise<void> {
    const landlord = await this.loadByIdOr404(id);
    const trimmedReason = LandlordsService.trimToNull(reason);
    if (landlord.submittedByUserId && !trimmedReason) {
      throw new BadRequestException(
        'Say why the entry is being removed. The member who suggested it reads this.',
      );
    }

    const suggesterUserId = landlord.submittedByUserId;
    const removed = {
      slug: landlord.slug,
      name: landlord.name,
    };
    // Nothing is stamped with the deciding moderator here, deliberately: the
    // row those columns live on is the row being deleted. The audit trail for
    // a removal is the removal.
    await this.landlords.remove(landlord);

    if (suggesterUserId) {
      await this.notifyDecision(
        suggesterUserId,
        NotificationType.LandlordSuggestionDecided,
        {
          source: 'landlord',
          decision: 'removed',
          landlordSlug: removed.slug,
          landlordName: removed.name,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        },
        `landlord ${id}`,
      );
    }
  }

  /**
   * The recommendations on one landlord entry, as a moderator sees them
   * (LOC-19).
   *
   * `removeRecommendation` below is keyed by a recommendation id that no
   * response in the API carried: the public landlord detail returns
   * `RecommendationDTO`, which has no `id`, so the DELETE route was
   * unreachable from any client. This is the admin-side read that supplies it,
   * and it stays admin-side so a public reader is never handed the key to
   * somebody else's row.
   *
   * Capped at `DEFAULT_LIST_LIMIT` and newest first, matching the public
   * detail read, and it 404s on an unknown landlord rather than answering an
   * empty list for an id that does not exist.
   */
  async listRecommendationsForAdmin(
    landlordId: string,
  ): Promise<AdminRecommendationDTO[]> {
    await this.loadByIdOr404(landlordId);
    const recs = await this.recommendations.find({
      where: { landlordId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const authorUserIds = recs.map((rec) => rec.authorUserId);
    const members = await new MemberLookup(this.profiles).byUserIds(
      authorUserIds,
    );
    const levels = await this.recLevels(authorUserIds);
    return recs.map((rec) =>
      toAdminRecommendationDTO(
        rec,
        members.get(rec.authorUserId) ?? null,
        levels.get(rec.authorUserId) ?? VerificationLevel.Email,
      ),
    );
  }

  async removeRecommendation(id: string): Promise<void> {
    const rec = await this.recommendations.findOne({ where: { id } });
    if (!rec) {
      throw new NotFoundException('Recommendation not found');
    }
    await this.recommendations.remove(rec);
  }

  /**
   * The introduction queue a moderator works (LOC-19): filtered by landlord
   * and by state, paginated, with the asking member resolved so the row is
   * about a person rather than a self-entered name.
   *
   * An unknown `landlord` slug returns an EMPTY page rather than a 404,
   * unchanged from before: the filter is a narrowing, and a console asking
   * about a landlord that has since been removed should see "nothing here".
   */
  async listIntroRequests(
    query: ListIntroRequestsQuery,
  ): Promise<Paginated<IntroRequestDTO>> {
    const page = normalizePage(query.page);
    let landlordId: string | undefined;
    if (query.landlord) {
      const landlord = await this.landlords.findOne({
        where: { slug: query.landlord },
      });
      if (!landlord) {
        return { items: [], total: 0, page, pageSize: PAGE_SIZE };
      }
      landlordId = landlord.id;
    }

    const qb = this.introRequests.createQueryBuilder('request');
    if (landlordId) {
      qb.andWhere('request.landlordId = :landlordId', { landlordId });
    }
    if (query.status) {
      qb.andWhere('request.status = :status', { status: query.status });
    }
    qb.orderBy('request.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const landlordById = await this.landlordsByIds(
        rows.map((row) => row.landlordId),
      );
      const requesterIds = [
        ...new Set(
          rows
            .map((row) => row.userId)
            .filter((userId): userId is string => Boolean(userId)),
        ),
      ];
      const requesters = requesterIds.length
        ? await new MemberLookup(this.profiles).byUserIds(requesterIds)
        : new Map<string, MemberRef>();
      return rows.map((request) =>
        toIntroRequestDTO(
          request,
          landlordById.get(request.landlordId) ?? null,
          request.userId ? (requesters.get(request.userId) ?? null) : null,
        ),
      );
    });
  }

  /**
   * Answer a request for an introduction (LOC-19).
   *
   * A landlord is not a platform member, so nobody but the staff team can
   * answer this, and until now the answer went nowhere: the requester's row
   * flipped to `accepted` or `declined` and they were never told either way,
   * having handed over their name, a note and a contact detail to ask.
   *
   * A decline REQUIRES a reason. IDEMPOTENT on a repeat of the same answer.
   */
  async triageIntroRequest(
    id: string,
    dto: TriageIntroRequestDto,
    adminUserId: string,
  ): Promise<IntroRequestDTO> {
    const request = await this.introRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Intro request not found');
    }

    const status =
      dto.action === 'accepted'
        ? LandlordIntroRequestStatus.Accepted
        : LandlordIntroRequestStatus.Declined;

    if (request.status === status && request.decidedAt) {
      return this.introRequestDTO(request);
    }

    const reason = LandlordsService.trimToNull(dto.reason);
    if (dto.action === 'declined' && !reason) {
      throw new BadRequestException(
        'Say why the introduction is not happening. The member who asked reads this.',
      );
    }

    request.status = status;
    request.decidedAt = new Date();
    request.decidedBy = adminUserId;
    request.decisionReason = reason;
    const saved = await this.introRequests.save(request);

    if (saved.userId) {
      const landlord = (await this.landlordsByIds([saved.landlordId])).get(
        saved.landlordId,
      );
      await this.notifyDecision(
        saved.userId,
        NotificationType.LandlordIntroRequestDecided,
        {
          source: 'landlord',
          decision: dto.action,
          landlordSlug: landlord?.slug ?? '',
          landlordName: landlord?.name ?? '',
          ...(reason ? { reason } : {}),
        },
        `landlord intro request ${saved.id}`,
      );
    }

    return this.introRequestDTO(saved);
  }

  /** Hand-map one intro request with its landlord and requester resolved. */
  private async introRequestDTO(
    request: LandlordIntroRequest,
  ): Promise<IntroRequestDTO> {
    const landlordById = await this.landlordsByIds([request.landlordId]);
    const requester = request.userId
      ? ((
          await new MemberLookup(this.profiles).byUserIds([request.userId])
        ).get(request.userId) ?? null)
      : null;
    return toIntroRequestDTO(
      request,
      landlordById.get(request.landlordId) ?? null,
      requester,
    );
  }

  /**
   * "Your landlord suggestion was decided" to the member who suggested it.
   * Silent when nobody suggested it (a staff-created entry has no submitter).
   */
  private async notifySuggester(
    landlord: Landlord,
    status: LandlordStatus,
    reason: string | null,
  ): Promise<void> {
    if (!landlord.submittedByUserId) return;
    await this.notifyDecision(
      landlord.submittedByUserId,
      NotificationType.LandlordSuggestionDecided,
      {
        source: 'landlord',
        decision: status,
        landlordSlug: landlord.slug,
        landlordName: landlord.name,
        ...(reason ? { reason } : {}),
      },
      `landlord ${landlord.id}`,
    );
  }

  /**
   * Best-effort in-app plus push delivery of a decision to the member it is
   * about. NEVER throws: the decision has already committed by the time this
   * runs, and a notification failure must not turn a completed moderation into
   * a 500 the moderator retries into a second decision. QueerPulse sends no
   * email, so there is no other channel involved.
   */
  private async notifyDecision(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    subject: string,
  ): Promise<void> {
    try {
      await this.notifications.create(userId, type, payload);
    } catch (error) {
      this.logger.warn(
        `Failed to notify member of ${subject}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Empty or whitespace-only free text stores as NULL, never as a blank. */
  private static trimToNull(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  // --- internals ---

  /**
   * The one member-facing by-slug loader: detail, recommend, withdraw-my-
   * recommendation and intro-request all come through here, so a moderator
   * takedown withholds the entry from all four at once. A hidden OR removed
   * entry 404s identically to an unknown slug, which is also what keeps a
   * taken-down entry from collecting new public ratings or intro requests.
   */
  private async loadLiveOr404(slug: string): Promise<Landlord> {
    const landlord = await this.landlords.findOne({
      where: { slug, status: LandlordStatus.Live },
    });
    if (!landlord) {
      throw new NotFoundException('Landlord not found');
    }
    const moderation = await this.contentModeration.stateFor(
      LandlordsService.SUBJECT_TYPE,
      slug,
    );
    if (moderation.hidden || moderation.removed) {
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
